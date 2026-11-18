# Writing tasks

A task is a script in the server's tasks folder. Its file name is the task name, its extension
picks the interpreter, and two optional neighbours complete it:

```
tasks/
  resize.py              the job script: task "resize"
  resize.cleanup.py      optional: runs when a finished job is cleaned up
  resize.schema.json     optional: what the job takes and prints
  lib/                   anything else: sub-folders and unknown extensions are not tasks
```

The server re-scans the folder on every request, so adding or removing a file takes effect at
once (`jobs tasks add`, or `PUT /tasks/:name` with upload enabled, do it for you).

## The contract: environment in, JSON lines out

| Variable | Value |
| --- | --- |
| `JOB_ID` | the job id (a UUID) |
| `JOB_TASK` | the task name |
| `JOB_PARAMS` | the params as JSON (`null` when none were given) |
| `JOB_DIR` | a scratch folder owned by the job, deleted with it |
| `JOB_OUTPUT_DIR` | the job's results folder `<outputs>/<id>/`, when the server has `--outputs` |
| `JOB_OUTPUT_URL` | the URL path that serves it, `<base-path>/outputs/<id>/`, likewise |

- **stdin** carries the job's input, if one was sent: bytes, exactly as uploaded. Without one,
  stdin is empty.
- **stdout**: one JSON value per line. Each becomes a message
  `{ status: "running", message: <value> }`. A line that is not JSON is kept as the string; blank
  lines are skipped. Flush after each line (`print(..., flush=True)`) if clients should see
  progress as it happens, not when the buffer fills.
- **stderr**: each line becomes `{ status: "running", error: <value> }`, parsed the same way.
- **exit code**: `0` ends the job `done`. Anything else ends it
  `{ status: "error", error: { code: "exit", exitCode, signal, stderr } }`, with the last 20
  stderr lines. A script that cannot start ends `{ code: "spawn", message }`.

The working directory is the script's folder, so a Python task can import helpers next to it
(`lib/` above), and a relative path in a script means the tasks folder.

```python
# tasks/count.py: counts its input
import json, os, sys

data = sys.stdin.buffer.read()
print(json.dumps({"bytes": len(data), "lines": data.count(b"\n"),
                  "params": json.loads(os.environ["JOB_PARAMS"])}))
```

### Interpreters

| Extension | Command |
| --- | --- |
| `js` `mjs` `cjs` `ts` `mts` | `node` (Node ≥ 22.18 runs TypeScript directly) |
| `py` | `python3` |
| `sh` | `bash` |
| `rb` | `ruby` |
| `r` `R` | `Rscript` |

Files with other extensions are not tasks. In TypeScript, `createJobManager({ launchers })` and
`discoverTasks(dir, launchers)` take a different table, e.g. `{ ts: ["tsx"] }`.

## Cleanup scripts remove what a job left behind

A job's own folder (`JOB_DIR`, the recorded messages) is deleted by the manager. Anything the
script put elsewhere (files in a results folder, objects in a bucket, rows in a database) is the
task's to delete, in `<name>.cleanup.<ext>`. It runs when a finished job is cleaned up, with the
same environment variables, and the job's recorded messages as JSONL on **stdin**, so it can
delete exactly what the job reported:

```python
# tasks/resize-out.cleanup.py (abridged)
import json, os, sys

out_dir = os.path.realpath(os.environ["JOB_OUTPUT_DIR"])
for line in sys.stdin:
    message = json.loads(line).get("message")
    if isinstance(message, dict) and "path" in message:
        path = os.path.realpath(message["path"])
        if os.path.dirname(path) == out_dir and os.path.exists(path):
            os.remove(path)
if os.path.isdir(out_dir):
    os.rmdir(out_dir)
```

If the cleanup script exits non-zero, the job is **kept**, and the cleanup result lists it under
`failed` with the exit code and stderr: `{ id, error: "cleanup exited with 1: …" }`. The next
cleanup retries it. A task without a cleanup script has nothing run: its results outside the job
folder stay forever. That is the failure mode to watch for with `--outputs`, a results folder that
only grows (empty per-job folders are removed at cleanup; folders with files are not).

## Schemas say what a task takes and prints

`<name>.schema.json` holds up to four JSON Schemas (draft 2020-12). Every part is optional; a
missing part, or a missing file, means no check, which is how every task without a schema
behaves.

```json
{
  "params":  { … },
  "body":    { … },
  "message": { … },
  "error":   { … }
}
```

| Part | Describes | Checked | On a mismatch |
| --- | --- | --- | --- |
| `params` | the JSON value in `JOB_PARAMS` | when the job is started, before anything is created | the start is refused: `invalid_params` with the issues (REST 400, MCP tool error, CLI exit 3); no job exists afterwards |
| `body`, a JSON Schema | the input is **JSONL**: one value per line, each matching the schema | line by line while the input is stored, before the job is queued | the start is refused naming the line (`input line 3: /amount: …`); nothing is kept |
| `body`, `{ "contentMediaType": … }` without `type` | the input is **opaque bytes** (an image, a PDF); the media type documents it | never | — |
| `message` | each stdout line (parsed JSON, or the raw string) | as each line is recorded | recorded as `{ status: "running", error: { code: "invalid_message", issues, raw } }`; the job continues |
| `error` | each stderr line (parsed JSON, or the raw string) | as each line is recorded | recorded as `{ status: "running", error: { code: "invalid_error", issues, raw } }`; the job continues |

An **issue** is `{ path, message }`, `path` a JSON Pointer into the value (`/` is the value
itself): `{ "path": "/sizes/0", "message": "Too small: expected number to be >=1" }`. `raw` is the
line exactly as printed.

### Why output mismatches don't stop the job

A job's outcome is its exit code, and stays that way with a schema. A schema mismatch in one
output line is recorded where it happened and the job carries on, because killing a two-hour job
over one malformed progress line loses more than it protects, and the line is not lost either:
`raw` keeps it. Clients that only want valid results read `message` payloads and treat
`invalid_message` as a defect report.

Params and input are different: a job started with bad params would fail later, after queuing
and maybe after expensive work, so those are refused at the door.

### Rules worth knowing

- **Checks never change values.** A `default` in a schema is not applied; the script gets exactly
  what the client sent, and clients get exactly what the script printed.
- **A non-JSON line against an object schema** is a mismatch (`expected object, received
  string`), with the text in `raw`. A Python traceback against an `error` schema that wants
  objects shows up as one `invalid_error` per traceback line, and the job then ends `error` by its
  exit code.
- **`format` is checked for the formats Zod knows** (`uri`, `email`, `date-time`, `uuid`, …).
  `uri-reference`, `iri-reference` and `uri-template` are annotations only, because Zod would check
  `uri-reference` as an absolute URL and reject a relative one like `/outputs/…`. Unknown formats
  are annotations.
- **A broken schema file disables that task, not the server.** A file that is not JSON, or a
  schema Zod cannot read (`"type": "objekt"`), leaves the task out of the listing; `jobs serve`
  prints `skipped task <name>: <file>: <reason>` at start, and the other tasks load. In
  TypeScript, `discoverTasks(dir, launchers, onSkip)` reports the same, and
  `manager.setTasks()` throws `task "<name>": invalid schema: …` for a definition built in code.
- **Uploads can carry a schema**: `PUT /tasks/:name` and the MCP `add_task` take
  `{ ext, script, cleanup?, schema? }`, write `<name>.schema.json`, and refuse a schema that does
  not compile (400) before writing anything.

### A JSONL input

```json
{
  "body": {
    "type": "object",
    "properties": { "name": { "type": "string" }, "amount": { "type": "number" } },
    "required": ["name", "amount"]
  },
  "message": { "type": "object", "properties": { "count": { "type": "integer" }, "total": { "type": "number" } } }
}
```

```sh
printf '{"name":"a","amount":1}\n{"name":"b"}\n' | jobs start records --input -
# jobs: invalid_params: input line 2: /amount: Invalid input: expected number, received undefined  (exit 3)
```

Blank lines are skipped, and an empty input is valid JSONL (zero lines). The check runs while the
input is being stored, so a 2 GB input with a bad line near the end is refused after it has been
read that far; no job is created either way.

## Binary data in and out

**In:** send the bytes as the job's input and give the task an opaque `body`
(`{ "contentMediaType": "image/png" }`). Over REST that is the raw request body (any content type
other than JSON and multipart) or a multipart `input` file; over MCP, `inputBase64`; with the
CLI, `--input photo.png`; in TypeScript, the `input` iterable of `Uint8Array`.

**Out:** stdout carries JSON lines, so a task cannot write raw bytes there. It has two ways to
return binary results.

### Inline, as base64

For small results. The `message` schema marks the field, and the `pattern` makes validation
catch anything that is not base64:

```json
"data": {
  "type": "string",
  "contentEncoding": "base64",
  "contentMediaType": "image/x-portable-pixmap",
  "pattern": "^[A-Za-z0-9+/]*={0,2}$"
}
```

Every byte travels through the message log, the REST streams and MCP results, three times larger
than a file would be. Above a few hundred kilobytes, use a results folder.

### In a results folder, reported by URL

`jobs serve --outputs ./outputs` (or `createJobManager({ outputs: { dir, url } })` plus
`createJobsApp(manager, { outputs: folderOutputs(dir) })`) gives every job a folder,
`<outputs>/<id>/`, created before the script starts. The script writes its results there and
reports each one:

```python
path = os.path.join(os.environ["JOB_OUTPUT_DIR"], "64.ppm")
with open(path, "wb") as f:
    f.write(image)
print(json.dumps({"size": 64, "url": os.environ["JOB_OUTPUT_URL"] + "64.ppm",
                  "path": path, "bytes": os.path.getsize(path)}), flush=True)
```

| Field | Use it when |
| --- | --- |
| `url` | the client is anywhere: `GET {server}{url}` returns the bytes, with a content type from the extension (`.png` → `image/png`, unknown → `application/octet-stream`) and the length |
| `path` | the client runs on the server's machine (the CLI, a local agent) and can read the file directly |

Describe both in the `message` schema (`"format": "uri-reference"` for `url`), so a client reading
the schema knows what to do with them. The server serves only regular files inside the job's own
folder: `..`, absolute paths, other jobs' files and symlinks pointing out answer 404. The cleanup
script deletes the files; the manager deletes none of them, and only removes the folder itself
when a cleaned-up job left it empty (every job gets one, even a task that never writes). Without
`--outputs`, the two variables are not set and `/outputs/…` is 404.

### In S3 (or any object store), with presigned URLs

In production the results usually go to an object store the server has no business holding
credentials for. The client creates presigned URLs and passes them in the params, one set per
result:

```json
{ "targets": [ { "size": 64,
                 "uploadUrl": "https://bucket.s3…/thumbs/64.ppm?X-Amz-…(PUT)",
                 "readUrl":   "https://bucket.s3…/thumbs/64.ppm?X-Amz-…(GET)",
                 "deleteUrl": "https://bucket.s3…/thumbs/64.ppm?X-Amz-…(DELETE)" } ] }
```

The script `PUT`s each result to its `uploadUrl` and reports `readUrl` as the result's `url`
(absolute this time). See `resize-s3.py` and `resize-s3.cleanup.py` in
[`test/fixtures/schemas/`](../test/fixtures/schemas/); the test runs them against a stand-in
store that checks a signature per method and key.

**A presigned PUT cannot delete.** A presigned URL grants one method on one key, so the cleanup
script needs its own way to delete. There are three, each with its own failure:

| Way | How | What breaks |
| --- | --- | --- |
| Presigned DELETE URLs in the params | the client signs them along with the PUTs; the cleanup script sends them | they expire (S3: at most 7 days with SigV4). A cleanup after expiry fails with **403**: the job stays, and `cleanup` reports `failed: [{ id, error: "cleanup exited with 1: DELETE …: 403 Forbidden" }]` on every retry until someone deletes by hand |
| Credentials on the server, scoped to the bucket or prefix | the cleanup script deletes with them (`aws s3 rm`, an SDK) | the server can now delete anything in scope; scope it to the prefix the jobs write |
| A bucket lifecycle rule | objects expire after N days; the cleanup script does nothing (or is omitted) | results vanish on the bucket's schedule, not the job's; a job cleaned up early leaves its objects until then |

Pick by who owns the bucket: the client (presigned DELETE), the service (server credentials), or
nobody in particular (lifecycle).
