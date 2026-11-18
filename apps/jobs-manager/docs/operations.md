# Running the server

## What it is

`jobs serve` is one Node process: the job manager, its file store, and an HTTP server with REST,
the OpenAPI document, MCP and (optionally) the results folders. It keeps no state outside its
folders, so stopping and starting it is safe at any time.

## Layout

```
tasks/                    --tasks: the scripts (re-scanned on every request)
.jobs/<id>/job.json       --data: the job's record, rewritten atomically on every status change
.jobs/<id>/messages.jsonl every message, appended in order
.jobs/<id>/input          the input, stored before the job is queued
.jobs/<id>/work/          JOB_DIR
outputs/<id>/             --outputs: the job's results, owned by the task
```

## How to run it

1. Put tasks in a folder (see [tasks.md](tasks.md)).
2. Start it, on loopback unless something in front of it authenticates:
   `jobs serve --tasks ./tasks --data ./.jobs --outputs ./outputs --retention-hours 72`.
3. Check what it found: the start lines on stderr list the tasks and any `skipped task …`.
4. Clean up finished jobs with `--retention-hours`, or `jobs cleanup --older-than 24h` from cron.

## Why it is the way it is

- **Inputs are stored before a job is queued.** A job can wait `pending` behind the concurrency
  limit, and still run after a restart, because its input is on disk, not in a request.
- **Each job runs in its own process group.** Interrupting sends SIGTERM to the group, so the
  script's children (a `sleep`, an ffmpeg) stop too; SIGKILL follows after the grace period (5 s)
  for anything that ignores SIGTERM.
- **The messages file is the truth.** After a crash, a torn last line is dropped, and a final
  message that reached the file but not `job.json` corrects `job.json`. No job is double-finished.
- **Results belong to the task.** The manager deletes a job's own folder; files in `--outputs` or
  elsewhere are deleted by the task's cleanup script, which knows what it wrote. The manager
  guessing would mean deleting files it did not create; it only removes a job's results folder
  once that is empty.
- **The adapters import nothing from Node**, so the REST/MCP layer can be reused on a Worker over
  a different manager; only `jobs serve`, the process manager and the folder helpers are Node.

## What will surprise you

| Symptom | Cause |
| --- | --- |
| A task is missing from `jobs tasks` | its schema file is not JSON or not a valid schema: see the `skipped task <name>: …` line at start, or run `discoverTasks` with `onSkip` |
| `jobs cleanup` keeps reporting the same job under `failed` | its cleanup script fails every time; the job (and its results) stay until the script succeeds. With presigned DELETE URLs, `403` in the error means they expired |
| The outputs folder only grows | a task wrote files and has no cleanup script, or its cleanup does not delete what it wrote (folders left empty are removed at cleanup) |
| `invalid_message` entries in a job's log | the script printed lines its `message` schema rejects; the job still ran, `raw` has the line |
| A browser client fails with a network/CORS error, curl works | the server was started without `--cors` for that origin |
| A `running` job became `interrupted` with `error.code: "restart"` | the server stopped while it ran; jobs are not resumed, start a new one |
| A second server on the same `--data` steals jobs | there is no lock file: one server per data folder |
| `follow_job` callers that gave up still hold a follower | MCP cancellation cannot reach a stateless server; the follower ends at disconnect or `timeoutMs` ([mcp.md](mcp.md)) |

## Security: what is and is not protected

- **No authentication** on REST, MCP or `/outputs`. Anyone who can reach the port can start,
  read, interrupt and clean up jobs, and read their results. Keep it on loopback or behind a proxy
  that authenticates.
- **Loopback is not a wall.** A web page on any site can send simple requests (a form POST) to a
  server on `localhost`; CORS only stops it from *reading* the answers, and there is no Host or
  Origin check. With task upload on, that is code execution: don't combine `--allow-task-upload`
  with a browser on the same machine you don't trust.
- **Task upload is off by default.** With `--allow-task-upload`, an upload is a script the server
  runs as its user; the server prints a warning when it starts so. Without it, the routes answer
  403 and the MCP tools are not listed.
- **Results are served only from inside the job's folder**: `..`, absolute paths, other jobs'
  files and symlinks pointing out answer 404.
- **Schemas are not a sandbox.** They check values; they do not limit what a script does.

## Reference

- Defaults: 4 concurrent jobs, 5 s kill grace, SSE keep-alive every 15 s, `job_logs` waits at most
  60 s and returns at most 1,000 messages, `follow_job` holds at most 30 min (default 5).
- `list()` reads every `job.json`: fine for thousands of jobs, an index would be needed beyond.
- Not implemented: authentication, per-task timeouts, output size limits, a lock file, resuming
  interrupted jobs.
- CLI flags: [cli.md](cli.md#jobs-serve).
