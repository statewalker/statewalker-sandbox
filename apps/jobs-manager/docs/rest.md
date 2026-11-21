# REST API

`createJobsApp(manager, options)` is a [Hono](https://hono.dev) app over any `JobManager`;
`jobs serve` runs it. Every route is declared with Zod through `@hono/zod-openapi`, and the same
schemas validate requests and produce the API's description:

```sh
curl -s localhost:8080/openapi.json     # OpenAPI 3.1: every route, body and stream item
```

Load that URL into Swagger UI, Scalar, or a client generator. The document lists the optional
routes only when they are on (`/outputs/…` with `outputs`, `/mcp` unless `mcp: false`), and its
paths include the base path.

## Routes

| Method & path | Does |
| --- | --- |
| `GET /openapi.json` | The OpenAPI document |
| `GET /tasks` | `[{ name, hasCleanup }]` |
| `PUT /tasks/:name` | Upload a task `{ ext, script, cleanup?, schema? }` → `201 { name, hasCleanup }`. Only with task upload on, else 403 |
| `DELETE /tasks/:name` | Remove it (script, cleanup, schema) → `{ removed }`. Only with task upload on |
| `POST /tasks/:task/jobs` | Start a job → `202 { jobId, statusUrl, logsUrl, eventsUrl }` and a `Location` header |
| `GET /jobs` | `JobInfo[]`, oldest first; `?status=error,interrupted&task=resize` |
| `GET /jobs/:id` | `{ id, task, params, status, created, updated }` |
| `GET /jobs/:id/logs` | NDJSON, one `JobMessage` per line: a snapshot, or `?follow=1` to stream to the end; `?since=<stamp>` resumes |
| `GET /jobs/:id/events` | Server-sent events, one per message, `id:` = stamp; closes after the final status; resume with `Last-Event-ID` or `?since=` |
| `DELETE /jobs/:id` | Interrupt → `{ id, status }` |
| `POST /cleanup` | Remove finished jobs (running cleanup scripts), `?before=<stamp>` (default now) → `{ removed, failed }` |
| `GET /outputs/:id/<path>` | A file from the job's results folder. Only with `outputs` |
| `POST /mcp` | MCP, see [mcp.md](mcp.md) |

## Starting a job: three body shapes

The content type decides how the body is read:

| Content type | Body | Params |
| --- | --- | --- |
| `application/json` | the params | — (no input) |
| `multipart/form-data` | field `params` (JSON text) and file `input` | in the form |
| anything else (`image/png`, `application/x-ndjson`, `application/octet-stream`, …) | the input stream, unchanged | `?params=<url-encoded JSON>` |

```sh
curl -s localhost:8080/tasks/count/jobs -H 'content-type: application/json' -d '{"n":1}'
curl -s localhost:8080/tasks/resize/jobs -F 'params={"sizes":[64]}' -F input=@photo.ppm
curl -s --data-binary @photo.ppm -H 'content-type: image/x-portable-pixmap' \
  "localhost:8080/tasks/resize/jobs?params=$(jq -rn '{sizes:[64]}|@uri')"
```

If the task has a schema, the params and (for a JSONL `body`) every input line are checked first;
a mismatch is a 400 and no job is created. See [tasks.md](tasks.md#schemas-say-what-a-task-takes-and-prints).

## Following a job

```sh
curl -N localhost:8080/jobs/<id>/events                 # SSE until the job ends
curl -s "localhost:8080/jobs/<id>/logs?follow=1"        # the same as NDJSON
curl -s "localhost:8080/jobs/<id>/logs?since=<stamp>"   # what came after a stamp
```

```js
const events = new EventSource(`${base}/jobs/${id}/events`);
events.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (["done", "error", "interrupted"].includes(m.status)) events.close();
};
```

A dropped SSE connection reconnects with `Last-Event-ID`, so `EventSource` resumes without loss
or duplicates. Each message is one of:

```
{ stamp, status: "pending" }
{ stamp, status: "running" }                                       process started
{ stamp, status: "running", message }                              a stdout line
{ stamp, status: "running", error }                                a stderr line
{ stamp, status: "running", error: { code: "invalid_message", issues, raw } }   a stdout line its schema rejected
{ stamp, status: "running", error: { code: "invalid_error", issues, raw } }     a stderr line its schema rejected
{ stamp, status: "done" }
{ stamp, status: "error", error: { code: "exit" | "spawn" | "unknown_task" | "internal", … } }
{ stamp, status: "interrupted", error? }                           error.code "restart" after a crash
```

`stamp` is epoch milliseconds (with microsecond fractions within one millisecond), strictly
increasing within a job: it orders messages and is the resume cursor everywhere.

## Fetching results

A task that writes to its results folder reports a `url` per file, a path on this server; resolve
it against the server's origin:

```sh
curl -s -o thumb.ppm "localhost:8080$(curl -s "localhost:8080/jobs/<id>/logs" \
  | jq -r 'select(.message.url) | .message.url' | head -1)"
```

The response carries a content type from the file's extension and its length. Anything outside
the job's own folder, a missing file, or a server without `outputs` answers
`404 { "error": { "code": "not_found", … } }`.

## Errors

Every error body is `{ "error": { "code", "message", "issues"? } }`:

| Status | Codes | When |
| --- | --- | --- |
| 400 | `invalid_params` | a malformed request (bad JSON, a bad stamp, a bad task name or extension, a name taken), or a value a task's schema rejects: then `issues` lists `{ path, message }` |
| 403 | `task_upload_disabled` | upload or removal on a server without task upload, whatever the body |
| 404 | `unknown_task`, `unknown_job`, `not_found` | no such task, job, route or result file |
| 405 | `method_not_allowed` | a known path with another method |
| 500 | `internal` | a bug: the message says what threw |

```json
{ "error": { "code": "invalid_params",
             "message": "params: /sizes/0: Too small: expected number to be >=1",
             "issues": [ { "path": "/sizes/0", "message": "Too small: expected number to be >=1" } ] } }
```

A bad `since`, `before` or `Last-Event-ID` is a 400, never read as "everything".

## Options

```ts
import { createJobsApp, folderOutputs, folderRegistry } from "@statewalker/jobs-manager-app";

const app = createJobsApp(manager, {
  basePath: "/api",                           // routes, URLs in responses and the document under /api
  registry: folderRegistry("./tasks", rescan), // accept task uploads: the server will run them
  outputs: folderOutputs("./outputs"),        // serve results folders at /api/outputs/…
  cors: { origin: ["http://localhost:5173"] },// or "*"; no CORS headers when omitted
  mcp: true,                                  // default
  keepAliveMs: 15_000,                        // SSE keep-alive comments
});
```

`createJobsHandler(manager, options)` returns the same app as `(Request) => Promise<Response>`.
On Node, `serve(app.fetch, { port, host })` runs it; under Bun, Deno or a Worker, export
`app.fetch`. A different `JobManager` and a different `OutputFiles` (over R2, say) plug into the
same options: the app itself imports nothing from Node.
