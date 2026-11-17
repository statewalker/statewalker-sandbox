# harness-proto-tools

## What it is

A **throwaway prototype** for the root ticket "How are OpenAPI tool definitions generated and
projected to MCP and Flue tools?" (statewalker/statewalker-root#90). It is a Worker project
run on CellB. Tools come from four sources:

- a plugin's native tools;
- harness tools;
- a remote MCP server;
- an existing REST API spec.

Each tool becomes **one OpenAPI 3.1 document** in a restricted profile. An agent session
derives two shapes from that same set:

- **pi-agent-core `AgentTool`s**, the tool type Flue's agent loop runs;
- a **per-session MCP endpoint** that lists and calls exactly the same set.

The set is narrowed by the user's role, the agent's request and the mode.

It reuses `../flue-capfs-do/src` for the Workspace cell: the store, the Biscuit authority and
the files gate. Native tools therefore reach files only through the user's capability.

## How to run it

```sh
pnpm install                                          # at the repository root
pnpm --filter @statewalker/harness-proto-tools test   # cellb, in-process
```

The tests start four things in-process:

- a scripted OpenAI-compatible model (`CALL <tool> <json>`);
- a fake MCP server;
- a fake REST API;
- the project on cellb (`loadProject`), with vars pointing at the three servers.

## What it shows

`tests/tools.test.mjs` checks:

- **The catalog:** every tool from every source becomes one definition. Each has one `POST`, a closed object input (`additionalProperties: false`), and a name made only of `[A-Za-z0-9_-]`, at most 64 characters.
- **REST import:** an imported REST operation is flattened into one object, and its route keeps where each argument goes. A non-object body is wrapped.
- **Narrowing:** the model and the MCP endpoint are offered exactly the narrowed set:
  - an editor sees more tools than a reader;
  - an agent's request can't widen the set;
  - plan mode doesn't offer write tools at all.
- **Refusals:** a forged call to a tool the session wasn't offered is refused, both by pi ("not found") and by MCP (`-32602`).
- **Approvals:**
  - an asking tool ends the turn (`terminate: true`);
  - approving re-checks the call, then runs it;
  - an approval given after a switch to plan is refused.
- **The capability:** a native tool can't read outside it.
- **Calls through the harness:**
  - MCP tools are called on the remote server, through the harness;
  - a REST call is rebuilt from its route: path, query, header, and an API key the model never sees.

## What is simplified

- **Native tools** are plain functions here. Bundling them and running them in a Worker Loader isolate is flue-capfs-do's part.
- **No user session.** `POST /v1/sessions` mints the user's workspace capability for the project and reads their role from the access file. User sessions are the subject of `../harness-proto-sessions`.
- **Members** live in `/.harness/<project>/access`, outside every session's rights. The system folder is hidden by the gate there.
