# jobs-manager

A service that runs named scripts as **jobs** and keeps everything they print. You drop
`resize.py` into a tasks folder; clients start a job of it with JSON parameters and an input
stream (an image, a JSONL file), follow its output while it runs, fetch the files it produced,
interrupt it, and clean it up later. The same jobs are reachable four ways: a TypeScript API, the
`jobs` CLI, REST (described by an OpenAPI document) and MCP, so an agent can drive them as tools.

- A **task** is a script: `resize.py`, with an optional cleanup script `resize.cleanup.py` and an
  optional schema `resize.schema.json`. The extension picks the interpreter.
- A **job** is one run of a task: JSON params in `JOB_PARAMS`, the input on stdin.
- Every **stdout line** is parsed as JSON and recorded as a message; every stderr line too.
  Clients read the messages while the job runs and after it ends.
- A task's **schema** says what its params, input and output lines look like. Jobs are checked
  against it: bad params never start a job, and bad output lines are recorded as such.

## Why it exists

Long-running work that is easiest to write as a script (image processing, data imports, model
runs) needs the same plumbing every time: a queue with a concurrency limit, a way to watch
progress, interruption that also stops the script's children, recovery after a restart, and a
cleanup step for whatever the script left behind. This service is that plumbing, once, with the
script contract kept as plain as a data loader: environment in, JSON lines out. Scripts stay in
whatever language suits them; Python, TypeScript and Bash run side by side.

The HTTP and MCP adapters use only Web-standard APIs, so the same API can sit in front of a
different job runner (Durable Objects, say) on a Worker. Only the process-based manager is Node.

## Quick start

From this folder, with `python3` and `bash` on the PATH:

```sh
pnpm install
mkdir -p tasks && cp test/fixtures/tasks/count.py tasks/
pnpm start --outputs ./outputs        # jobs serve: REST + OpenAPI + MCP on http://127.0.0.1:8080
```

In another terminal:

```sh
export JOBS_URL=http://127.0.0.1:8080
pnpm jobs tasks                                   # count
printf 'a\nb\n' | pnpm jobs start count -p n=2 --input - --follow
curl -s localhost:8080/openapi.json | head -c 200 # the API's OpenAPI 3.1 document
```

`--follow` prints each message as it arrives and exits with the job's outcome (0 done, 1 error,
2 interrupted). For agents: `claude mcp add --transport http jobs http://127.0.0.1:8080/mcp`.

## How to use it

| You are | Start with | Guide |
| --- | --- | --- |
| Writing a task | environment in, JSON lines out, optional schema | [docs/tasks.md](docs/tasks.md) |
| Calling it over HTTP | `GET /openapi.json`, `POST /tasks/:task/jobs`, `GET /jobs/:id/events` | [docs/rest.md](docs/rest.md) |
| Connecting an agent | MCP at `/mcp`: `start_job`, `follow_job`, `job_logs` | [docs/mcp.md](docs/mcp.md) |
| Working in a shell | `jobs start`, `jobs logs --follow`, `jobs result` | [docs/cli.md](docs/cli.md) |
| Running the server | flags, security, storage, recovery | [docs/operations.md](docs/operations.md) |
| Changing the code | layers, lifecycle, the contract each module keeps | [docs/architecture.md](docs/architecture.md) |

In TypeScript, the manager and the client implement one interface, `JobManager`
([`src/types.ts`](src/types.ts)), so code written against it runs in process or against a remote
server unchanged:

```ts
import { createJobManager, discoverTasks, JobsClient } from "@statewalker/jobs-manager-app";

const manager = await createJobManager({ root: "./.jobs", tasks: await discoverTasks("./tasks") });
// or: const manager = new JobsClient("http://127.0.0.1:8080");

const id = await manager.start("count", { n: 2 }, [new TextEncoder().encode("a\nb\n")]);
for await (const message of manager.logs(id)) console.log(message); // follows to the end
await manager.cleanup(); // removes finished jobs, running their cleanup scripts
```

## Example: a task that resizes images, with a schema

`resize-out.py` reads a PPM image on stdin, writes one file per requested size into the job's
results folder and reports where each one is. Its schema, `resize-out.schema.json`, says what it
takes and what it prints (trimmed; the full file is in
[`test/fixtures/schemas/`](test/fixtures/schemas/)):

```json
{
  "params":  { "type": "object", "properties": { "sizes": { "type": "array", "items": { "type": "integer", "minimum": 1 } } }, "required": ["sizes"] },
  "body":    { "contentMediaType": "image/x-portable-pixmap" },
  "message": {
    "type": "object",
    "properties": {
      "size": { "type": "integer" },
      "url":  { "type": "string", "format": "uri-reference", "description": "Where to GET the image: a path on the jobs server" },
      "path": { "type": "string", "description": "The file on the server's disk; usable only on the same machine" },
      "bytes": { "type": "integer" }
    },
    "required": ["size", "url", "path", "bytes"]
  }
}
```

With the server started as `jobs serve --outputs ./outputs`:

```sh
curl -s --data-binary @photo.ppm -H 'content-type: image/x-portable-pixmap' \
  "localhost:8080/tasks/resize-out/jobs?params=%7B%22sizes%22%3A%5B64%5D%7D"
# 202 {"jobId":"3f…","statusUrl":"/jobs/3f…","logsUrl":"/jobs/3f…/logs","eventsUrl":"/jobs/3f…/events"}

curl -s "localhost:8080/jobs/3f…/logs?follow=1"
# {"stamp":…,"status":"pending"}
# {"stamp":…,"status":"running"}
# {"stamp":…,"status":"running","message":{"size":64,"width":64,"height":48,"url":"/outputs/3f…/64.ppm","path":"/…/outputs/3f…/64.ppm","bytes":9231}}
# {"stamp":…,"status":"done"}

curl -s -o thumb.ppm localhost:8080/outputs/3f…/64.ppm   # the result's bytes
```

`{"sizes":[0]}` would be refused before anything runs:
`400 {"error":{"code":"invalid_params","message":"params: /sizes/0: Too small: expected number to be >=1","issues":[{"path":"/sizes/0",…}]}}`.
Cleaning the job up runs `resize-out.cleanup.py`, which deletes the files the job reported.
[docs/tasks.md](docs/tasks.md) walks through every part, including the S3 variant with presigned
URLs.

## Internals

- **One interface, several faces.** `ProcessJobManager` runs each job as a child process in its
  own process group and persists everything through `FileJobStore` (one folder per job). The REST
  app, the MCP handler and `JobsClient` take any `JobManager`.
- **Runtime-agnostic adapters.** `@statewalker/jobs-manager-app/web` exports the REST app, the MCP
  handler, the client, the schema checks and the types, and nothing reachable from it imports a
  Node built-in. A test walks the import graph and another scans the built bundle, because a stray
  `node:` import would otherwise surface only as a crash on the first Worker deploy.
- **Schemas are JSON Schema, checked with Zod.** `z.fromJSONSchema` compiles each part once per
  distinct schema; checks report and never coerce. The REST routes are declared with Zod too
  (`@hono/zod-openapi`), so request validation and the OpenAPI document come from one source.
- **Stamps are the cursor.** Every message has a stamp (epoch ms with microsecond fractions),
  strictly increasing within a job; logs resume after a stamp over every interface.
- **Dependencies:** Hono and `@hono/zod-openapi` (HTTP app, OpenAPI), Zod (schemas), the MCP
  server SDK, `@hono/node-server` (Node serving), citty (CLI). Tests need `python3` and `bash`.

Build, test and the toolchain:

```sh
pnpm --filter @statewalker/jobs-manager-app build       # tsdown: dist/index.mjs, dist/web.mjs, dist/cli.mjs
pnpm --filter @statewalker/jobs-manager-app test        # ~35 s: two tests stream a 30 s job
pnpm --filter @statewalker/jobs-manager-app typecheck
pnpm turbo run test --filter=@statewalker/jobs-manager-app
```

## License

Private prototype in this repository; not published.
