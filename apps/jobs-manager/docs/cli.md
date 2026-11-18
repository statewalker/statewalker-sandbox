# The `jobs` CLI

One command for the server and its clients. Client commands talk to `--url`, which defaults to
`$JOBS_URL`, then `http://127.0.0.1:8080`. `jobs help` prints the overview, `jobs <command> --help`
one command's options. In this repository run it as `pnpm jobs …` from the app folder, or
`node dist/cli.mjs …` after a build.

```sh
jobs serve --tasks ./tasks --data ./.jobs --outputs ./outputs --port 8080 &
export JOBS_URL=http://127.0.0.1:8080

jobs tasks add ./resize.py --cleanup ./resize.cleanup.py   # the server picks it up at once
jobs tasks                                                 # resize  (+cleanup)

id=$(jobs start resize -p 'sizes=[64,128]' --input photo.ppm)
jobs logs "$id" --follow          # time, status, stdout/stderr, payload
jobs wait "$id" --timeout 5m      # exit 0 done, 1 error, 2 interrupted, 124 timeout
jobs result "$id"                 # the stdout lines, as JSONL
jobs verify "$id" --status done --count 2 --contains '{"size":64}'
jobs list --status error,interrupted
jobs interrupt "$id"
jobs cleanup --older-than 24h
```

Launch and follow in one go: `jobs start resize -p 'sizes=[64]' --input photo.ppm --follow`.

## `jobs serve`

| Flag | Default | Does |
| --- | --- | --- |
| `--tasks <dir>` | `./tasks` | The tasks folder. Created when missing, re-scanned on every request |
| `--data <dir>` | `./.jobs` | One folder per job: record, messages, input |
| `--outputs <dir>` | off | Results folders: each job gets `<dir>/<id>/` as `JOB_OUTPUT_DIR`, served at `<base-path>/outputs/<id>/` |
| `--port`, `--host` | `8080`, `127.0.0.1` | Where to listen; `--port 0` picks a free port |
| `--base-path <path>` | none | Prefix of every route, e.g. `/api` |
| `--max-concurrent <n>` | `4` | Jobs running at once; the rest wait `pending` |
| `--retention-hours <n>` | off | Clean up finished jobs older than this, periodically |
| `--allow-task-upload` | off | Accept `PUT`/`DELETE /tasks/:name` and MCP `add_task`/`remove_task`: anyone who can reach the server can then run code on it |
| `--no-mcp` | MCP on | Do not serve `/mcp` |
| `--cors <origins>` | off | CORS headers for these origins, comma-separated, or `*` |

At start it prints the URL to stdout, then to stderr: the tasks folder with the tasks found, one
`skipped task <name>: <reason>` line per task whose schema file is broken, the outputs folder, the
MCP URL, and a warning when upload is on. SIGINT or SIGTERM stops it; running jobs are recorded as
`interrupted`.

## Client commands

| Command | Does |
| --- | --- |
| `tasks [--json]` | Lists the server's tasks |
| `tasks add <script> [--name n] [--cleanup script] [--tasks dir]` | Copies a script (and its cleanup) into the tasks folder; refuses to overwrite |
| `tasks remove <name> [--tasks dir]` | Deletes a task's files |
| `start <task>` | Prints the job id. `-p key=value` (repeatable; each value parsed as JSON when it can be), `--params <json>` for all at once, `--input <file\|->` for the input, `--wait` or `--follow` to wait for the end, `--json` |
| `status <id>`, `info <id>` | The status; the record as JSON |
| `list [--status a,b] [--task name] [--json]` | Jobs, oldest first |
| `logs <id> [--since stamp] [--follow] [--until-message] [--json]` | Readable lines or JSONL; `--until-message` stops at the first stdout message |
| `wait <id> [--timeout 30s]` | Exits with the job's outcome |
| `result <id> [--last]` | The stdout messages as JSONL |
| `verify <id> [--status s] [--count n] [--contains json]... [--last json] [--expect file.jsonl]` | Waits, then checks; exits 0 if everything holds, 1 naming each failure |
| `interrupt <id>` | Stops a pending or running job |
| `cleanup [--older-than 24h \| --before stamp] [--json]` | Removes finished jobs, running cleanup scripts |

## Exit codes

| Code | Means |
| --- | --- |
| 0 | the job finished `done` (or the command succeeded) |
| 1 | the job finished `error`, or `verify` found a failure |
| 2 | the job was `interrupted` |
| 3 | a usage error, an unreachable server, an unknown task or job, or params / input a task's schema rejects |
| 124 | `wait --timeout` gave up |

A schema rejection prints the code and the server's message, naming the path or line:

```
$ jobs start resize -p 'sizes=[0]'
jobs: invalid_params: params: /sizes/0: Too small: expected number to be >=1
```

The CLI is a thin layer over `JobsClient`, which implements `JobManager` over REST.
