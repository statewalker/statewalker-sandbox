# jobs-manager

Runs named long-running tasks as shell commands and stores what they print. It works like
[Observable Framework data loaders](https://observablehq.com/framework/data-loaders), but each run
is a *job* that clients can start, follow, interrupt and clean up, over a TypeScript API or REST.

- A **task** is a script, `image-generator.ts`, plus an optional cleanup script,
  `image-generator.cleanup.ts`. The file extension picks the launcher.
- A **job** is one run of a task with JSON parameters and an optional input byte stream.
- Each **stdout line** is parsed as JSON and recorded as a message. Each stderr line is recorded
  too. Clients read the messages while the job runs and after it finishes.

Prototype status: about 2,000 lines in `src/`, one runtime dependency (citty, for the CLI), and
79 tests. See [docs/architecture.md](docs/architecture.md) and
[docs/parallel-report.md](docs/parallel-report.md).

## Toolchain

The same toolchain as the rest of this repository:

| Tool | Role |
| --- | --- |
| TypeScript 7 | Type checking (`tsc --noEmit`). The source runs directly on Node ≥ 22.18, which strips types. |
| tsdown (rolldown) | `build`: bundles `dist/index.mjs`, `dist/cli.mjs` (the `jobs` bin) and type declarations. |
| Vitest (Vite) | `test`. A global setup builds `dist/` first, so the bundle is tested too. |
| Turbo | `turbo run test` runs `build`, then `test`, and caches `dist/`. |
| Biome | Lint and format. |

From the repository root:

```sh
pnpm install
pnpm --filter @statewalker/jobs-manager-app build       # tsdown → dist/
pnpm --filter @statewalker/jobs-manager-app test        # ~30 s: two tests stream a 30 s job
pnpm --filter @statewalker/jobs-manager-app typecheck
pnpm turbo run test --filter=@statewalker/jobs-manager-app
pnpm --filter @statewalker/jobs-manager-app report out.json   # 36 jobs at 5 limits + REST
```

The tests need `python3` and `bash` on the PATH; Linux and macOS have both.

## The `jobs` CLI

There's one command for the server and the client. Client commands talk to `--url`, which
defaults to `$JOBS_URL`, then `http://127.0.0.1:8080`. Run `jobs help` for the overview, and
`jobs <command> --help` for one command's options. In this repository, run it as `pnpm jobs …`
from the app folder, or as `node dist/cli.mjs …` after a build.

```sh
jobs serve --tasks ./tasks --data ./.jobs --port 8080 &
export JOBS_URL=http://127.0.0.1:8080

jobs tasks add ./resize.py --cleanup ./resize.cleanup.py   # the server picks it up at once
jobs tasks                                                 # resize  (+cleanup)

id=$(jobs start resize -p width=64 -p 'formats=["png","webp"]' --input photo.jpg)
jobs logs "$id" --follow                                   # time, status, stdout/stderr, payload
jobs wait "$id" --timeout 5m                               # exit 0 done, 1 error, 2 interrupted
jobs result "$id"                                          # the stdout lines, as JSONL
jobs verify "$id" --status done --count 2 --contains '{"format":"webp"}'
jobs list --status error,interrupted
jobs interrupt "$id"
jobs cleanup --older-than 24h
```

| Command | Does |
| --- | --- |
| `serve` | Runs the server. It creates `--tasks` (default `./tasks`) when it is missing, prints its absolute path with the tasks found, and re-scans it on every request, so `tasks add` and `tasks remove` apply at once. A fresh folder starts with no tasks: `jobs tasks` prints nothing until you add one. |
| `tasks [add <script> \| remove <name>]` | Lists the tasks, or copies a script (and its `--cleanup`) into the tasks folder, or deletes one. |
| `start <task>` | Prints the job id. `-p key=value` is repeatable, and each value is parsed as JSON when it can be. `--params <json>` gives all parameters at once, `--input <file\|->` sends an input, and `--wait` or `--follow` waits for the end. |
| `status`, `info`, `list` | The job's status; its record as JSON; all jobs, filtered with `--status a,b` and `--task`. |
| `logs <id>` | Readable lines, or `--json`. Add `--since <stamp>` to resume, `--follow` to keep printing until the end. |
| `wait <id>` | Exits with the job's outcome. `--timeout` gives up with exit 124. |
| `result <id>` | The result messages (stdout lines) as JSONL; `--last` prints only the last one. |
| `verify <id>` | Waits for the job, then checks it: `--status`, `--count`, `--contains <json>` (repeatable; matches any subset), `--last <json>`, `--expect <file.jsonl>` (the results in order). Exits 0 if everything holds, 1 otherwise, naming each failure. |
| `interrupt <id>`, `cleanup` | Stops a job. `cleanup` removes finished jobs, `--older-than 24h` or `--before <stamp>`. |

**Exit codes:**

- `0`: the job finished `done`
- `1`: the job finished `error`, or `verify` found a failure
- `2`: the job was `interrupted`
- `3`: a usage error, an unreachable server, or an unknown task or job
- `124`: `wait --timeout` gave up

The CLI is a thin layer over `JobsClient`, which implements the same `JobManager` interface over
REST. Code written against `JobManager` therefore runs unchanged in process or against a remote
server.

## Writing a task

A task script gets its context from environment variables:

| Variable     | Value                                                         |
| ------------ | ------------------------------------------------------------- |
| `JOB_ID`     | the job id (a UUID)                                           |
| `JOB_TASK`   | the task name                                                 |
| `JOB_PARAMS` | the parameters as JSON                                        |
| `JOB_DIR`    | a scratch directory owned by the job, deleted with it         |

The input stream, if one was given, arrives on **stdin**. With no input, stdin is empty.

What the script writes:

- **stdout**: one JSON value per line. A line that is not JSON is kept as a string, and blank
  lines are skipped.
- **stderr**: each line is recorded as `{ status: "running", error }`. The output is parsed the
  same way as stdout.
- **exit code**: `0` gives `done`. Any other code gives `error` with
  `{ code: "exit", exitCode, signal, stderr }`, where `stderr` holds the last 20 lines.

```ts
// tasks/image-generator.ts
const { sizes } = JSON.parse(process.env.JOB_PARAMS!);
for (const size of sizes) {
  const key = await resizeAndUpload(process.stdin, size); // your code
  console.log(JSON.stringify({ key, size }));
}
```

A **cleanup script** runs when a finished job is cleaned up. It gets the same environment
variables, and the job's recorded messages arrive as JSONL on **stdin**. That lets it delete
whatever the job reported:

```ts
// tasks/image-generator.cleanup.ts
for await (const line of readline.createInterface({ input: process.stdin })) {
  const { message } = JSON.parse(line);
  if (message?.key) await s3.deleteObject(message.key);
}
```

If the cleanup script exits non-zero, the job is kept and reported under `failed`, so a later
cleanup retries it.

### Launchers

| Extension          | Command                                              |
| ------------------ | ---------------------------------------------------- |
| `js` `mjs` `cjs`   | `node`                                               |
| `ts` `mts`         | `node`, which strips types natively on Node ≥ 22.18  |
| `py`               | `python3`                                            |
| `sh`               | `bash`                                               |
| `rb`               | `ruby`                                               |
| `r` `R`            | `Rscript`                                            |
| anything else      | executed directly, so it must be executable          |

You can override the table, for example `launchers: { ts: ["tsx"] }`.

## TypeScript API

```ts
import { createJobManager, discoverTasks, JobsClient } from "@statewalker/jobs-manager-app";

const manager = await createJobManager({
  root: "./.jobs",                       // one directory per job
  tasks: await discoverTasks("./tasks"), // or [{ name, script, cleanup?, cwd?, env? }]
  maxConcurrent: 4,                      // the rest wait as "pending"
  killGraceMs: 5000,                     // SIGTERM, then SIGKILL after this
  retention: { maxAgeMs: 24 * 3600_000 },// periodic cleanup of old finished jobs
});

const id = await manager.start("image-generator", { sizes: [64, 128] }, imageChunks);
for await (const m of manager.logs(id)) console.log(m); // follows until the job ends
await manager.status(id);     // "pending" | "running" | "done" | "error" | "interrupted"
await manager.interrupt(id);  // resolves with the final status
for await (const job of manager.list({ status: "done" })) console.log(job);
await manager.cleanup(Date.now() - 3600_000); // { removed, failed }
await manager.close();        // interrupts this manager's jobs and stops the timer
```

The full contract is `JobManager` in [`src/types.ts`](src/types.ts).

### Messages

```ts
type JobMessage =
  | { stamp; status: "pending" }
  | { stamp; status: "running" }                  // process started
  | { stamp; status: "running"; message: Json }   // one stdout line
  | { stamp; status: "running"; error: Json }     // one stderr line
  | { stamp; status: "done" }
  | { stamp; status: "error"; error: Json }       // { code: "exit" | "spawn" | ..., ... }
  | { stamp; status: "interrupted"; error? };     // error.code "restart" after a crash
```

`status` is always the job's status at the time the message was recorded. The payload field says
where the message came from.

`stamp` is the time in epoch milliseconds, with microsecond fractions. Stamps are **strictly
increasing within a job**, so a stamp identifies a message. `logs(id, since)` resumes exactly
after it, and SSE uses the stamp as the event id.

## REST API

The adapter is `createJobsHandler(manager, { basePath })`, a fetch-style `Request → Response`
handler. It runs on Node through `serve()`, and unchanged on Bun, Deno or Workers.

| Method & path               | Behaviour |
| --------------------------- | --------- |
| `GET /tasks`                | `[{ name, hasCleanup }]` |
| `POST /tasks/:task/jobs`    | `202 { jobId, statusUrl, logsUrl, eventsUrl }` plus a `Location` header. The body is one of: `application/json` (the params); `multipart/form-data` (a `params` field holding JSON and an `input` file); any other type (the input stream, with params in `?params=<json>`) |
| `GET /jobs`                 | `JobInfo[]`, oldest first. Filter with `?status=error,interrupted` and `&task=name` |
| `GET /jobs/:id`             | `{ id, task, params, status, created, updated }` |
| `GET /jobs/:id/logs`        | NDJSON. Returns a snapshot by default; `?follow=1` streams until the end; `?since=<stamp>` resumes |
| `GET /jobs/:id/events`      | SSE, one event per message (`id:` is the stamp). Closes after the final status. Resume with `Last-Event-ID` or `?since=` |
| `DELETE /jobs/:id`          | Interrupts the job and returns `{ id, status }` |
| `POST /cleanup`             | `?before=<stamp>` (default: now) returns `{ removed, failed }` |

Errors come back as `{ error: { code, message } }`:

- 400: `invalid_params`
- 404: `unknown_task`, `unknown_job`, `not_found`
- 405: `method_not_allowed`
- 500: `internal`

```sh
curl -s localhost:8080/tasks/count/jobs -H 'content-type: application/json' -d '{"n":1}'
curl -s --data-binary @photo.png "localhost:8080/tasks/image-generator/jobs?params=%7B%22sizes%22%3A%5B64%5D%7D"
curl -N localhost:8080/jobs/<id>/events
```

## Storage

The first store is `FileJobStore`, which keeps one directory per job under `root`:

```
<root>/<id>/job.json        JobInfo, rewritten atomically on every status change
<root>/<id>/messages.jsonl  every message, appended in order
<root>/<id>/input           the input stream, saved before the job is queued
<root>/<id>/work/           JOB_DIR
```

The input is saved to disk first. That means a job can wait as `pending` behind the concurrency
limit, and still run after a restart.

**Recovery.** On start, the manager scans `root`:

- A `running` job lost its manager. Its process group, whose id is saved in `job.json`, is
  killed: on Linux only after checking that a member still carries the job's `JOB_ID`. The job
  becomes `interrupted` with `error.code: "restart"`.
- A `pending` job is queued again, together with its saved input.
- The messages file is the source of truth. A line torn by a crash mid-append is dropped. If the
  last message is already final but `job.json` missed the update, `job.json` is corrected; no
  second final message is appended.

**One manager per root directory.** There is no lock file. A second live manager on the same
root would take the first one's pending jobs.

## Behaviour worth knowing

- **Interrupting** sends SIGTERM to the whole **process group**, so children such as `sleep` or a
  subshell stop too. SIGKILL follows after `killGraceMs`, even if the script itself has already
  exited, so processes that ignore SIGTERM still stop. Interrupting a pending job removes it from
  the queue without running it.
- **Starting a job is all or nothing.** If the input stream fails while it is being saved (for
  example the client disconnects mid-upload), `start()` rejects and nothing is kept.
- **Bad stamps are rejected.** A `before`, `since` or `Last-Event-ID` that isn't a number returns
  400. It is never read as "everything".
- **Fast scripts keep their output.** Node discards child output that has no reader when the
  child exits (`flushStdio`). The readers are therefore attached in the same tick as `spawn`, and
  a regression test runs 20 instant jobs.
- **`logs()` follows by default.** Pass `{ follow: false }` for a snapshot, and `{ signal }` to
  stop a follower. The REST layer aborts the follower when the client disconnects.

## Open questions and limits

- **No authentication** on the REST API. Keep it on a private network or put it behind a proxy.
- **Reruns start from scratch.** An interrupted job is not restarted; the client starts a new one.
- **`list()` reads every `job.json`.** That's fine for thousands of jobs; an index would be
  needed for more.
- **Per-task timeouts, output size limits and a lock file** are not implemented.
- **`JobTimeStamp` is a fractional number** rather than a `Date`, so that stamps stay JSON-safe
  and strictly ordered.
