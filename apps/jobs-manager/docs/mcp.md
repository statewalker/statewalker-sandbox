# MCP: the jobs as agent tools

The server speaks MCP (Streamable HTTP) at `<base-path>/mcp`, next to REST, over the same
manager. It is stateless: every request gets a fresh MCP server, so there are no sessions to keep
or expire, and it answers both the current protocol revision and the 2025 revisions most clients
send. `jobs serve --no-mcp` turns it off.

## Connecting a client

```sh
claude mcp add --transport http jobs http://127.0.0.1:8080/mcp     # Claude Code
npx @modelcontextprotocol/inspector                                 # a UI to call tools by hand
```

In the Inspector, pick transport **Streamable HTTP** and URL `http://127.0.0.1:8080/mcp`. A
browser-based client on another origin (the Inspector's own page is one) needs the server started
with `--cors <its origin>` or `--cors '*'`; without it the browser reports a CORS error and the
client a generic connection failure, while curl works fine. That mismatch is the symptom.

## Tools

| Tool | Arguments → result |
| --- | --- |
| `list_tasks` | → `{ tasks: [{ name, hasCleanup }] }` |
| `start_job` | `{ task, params?, input? \| inputBase64? }` → `{ jobId }`. `input` is text for stdin, `inputBase64` binary |
| `follow_job` | `{ id, since?, timeoutMs? }` → `{ messages, next, status, finished }`, streaming each message as a progress notification |
| `job_logs` | `{ id, since?, waitMs? }` → `{ messages, next, status, finished }` |
| `get_job` | `{ id }` → the job's record |
| `list_jobs` | `{ status?: [...], task? }` → `{ jobs }`, oldest first |
| `interrupt_job` | `{ id }` → `{ id, status }` |
| `cleanup_jobs` | `{ before? }` → `{ removed, failed }` |
| `add_task`, `remove_task` | `{ name, ext, script, cleanup?, schema? }`; `{ name }`. Listed only when task upload is on |

Errors are tool errors whose text starts with the code, so an agent can tell a typo from a
failure: `unknown_job: …`, `unknown_task: …`, and for a schema mismatch
`invalid_params: params: /sizes/0: Too small: expected number to be >=1`.

## Two ways to follow a job

A tool call returns one result, while a job produces messages over time. There are two tools for
that, and both return the same page shape:

```
{ messages: JobMessage[], next: <cursor>, status: <job status now>, finished: boolean }
```

`finished` is true only once the job's **final message** has been returned: in this page, or
before the cursor you passed. Pass `next` back as `since` to continue from exactly where the page
ended; stamps are strictly increasing, so nothing is skipped or repeated.

### `follow_job`: one call, messages as they happen

```json
{ "name": "follow_job", "arguments": { "id": "3f…" }, "_meta": { "progressToken": 1 } }
```

The call stays open until the job ends. Each new message is sent right away as a progress
notification, `{ progressToken, progress: <n>, message: "<the JobMessage as JSON>" }`, with
`progress` counting 1, 2, 3, …. The final result holds every message again, so a client that
ignores notifications (many do) loses nothing.

It returns early, with `finished: false` and a cursor, after `timeoutMs` (default 300,000 ms, max
1,800,000) or after 1,000 messages. Continue with `follow_job` or `job_logs` from `next`.

**Cancelling needs the connection to close.** When a client cancels a call, MCP clients send a
separate `notifications/cancelled`. A stateless server cannot match that to the call still
running, so the follow continues until the client drops the HTTP request (closing the transport,
or the process exiting, does that) or `timeoutMs` passes. Give long follows a `timeoutMs` that
matches how long you are willing to hold a follower open.

### `job_logs`: a cursor loop that works with every client

```
page = job_logs({ id })
while not page.finished:
    page = job_logs({ id, since: page.next, waitMs: 30000 })
```

With `waitMs` (up to 60,000), a call that finds nothing new waits for the next message instead of
returning empty: a long-poll. A call that waited and got nothing returns
`{ messages: [], next: <your since>, finished: false }`, which means "nothing yet", not an error.
One call returns at most 1,000 messages; `finished` stays false while more are pending.

Use `follow_job` when the client shows notifications or can hold a call open; use `job_logs` when
calls must stay short (some hosts time tool calls out after a minute or two).

## Binary input and results

`start_job` takes binary input as `inputBase64`. Results come back the way the task reports them
([tasks.md](tasks.md#binary-data-in-and-out)): inline base64 in the messages, or a `url` into the
server's results folder (`/outputs/<id>/…`, relative to the server) that the agent fetches over
HTTP, or a presigned object-store URL. A task's schema checks `params` before a job starts, so an
agent gets the `invalid_params` issues back as the tool error and can correct its call.
