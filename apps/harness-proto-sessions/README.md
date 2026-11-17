# harness-proto-sessions

## What it is

A **throwaway prototype** for the root ticket "How does a user session start agent sessions,
and can the two merge?" (statewalker/statewalker-root#89). It is a Worker project run on
CellB, with three Durable Objects:

- an **Issuer**, which signs short-lived access tokens: user, workspace, expiry;
- a **Workspace**, which holds:
  - the store;
  - the role source (each project's `.system/access` file);
  - user sessions, agent sessions and approvals;
  - the gate every file call of every agent goes through;
- one **AgentSession** per agent session, running Flue's agent loop (pi-agent-core) with Flue's own file tools over the session's capability.

It reuses `../flue-capfs-do/src` for the store (`SqlFs`), the just-bash file system over a
capability (`CapFs`) and Flue's `rg`.

## How to run it

```sh
pnpm install                                             # at the repository root
pnpm --filter @statewalker/harness-proto-sessions test   # cellb, in-process
```

## What it shows

`tests/sessions.test.mjs` checks:

- **User sessions:**
  - an access token opens the user session, and a second token resumes the same one;
  - the user session holds the mode;
  - pending approvals are listed on the user session.
- **Tool sets:**
  - an agent's tools are what it asks for, cut to the role;
  - a sub-agent's ceiling is its parent's tools;
  - the model is offered exactly those.
- **The file view:**
  - a project the user isn't a member of can't be started and isn't visible;
  - the system folder is never visible (`ENOENT`).
- **Modes:**
  - a write asks first in `default` mode, and the turn stops;
  - approving runs the stored write;
  - approving after a switch to `plan` re-checks the write and refuses it;
  - deny takes a reason;
  - a sub-agent's own mode only adds strictness.
- **Live roles:** a demotion reaches a running session at its next action. Its tool set isn't rebuilt, but the call is refused.
- **Token expiry:** an agent keeps working after the user's access token expires, because it holds its capability, not the token. A new token resumes the same user session.
- **Revocation:**
  - revoking an agent session stops it and its sub-agents, and a sibling keeps running;
  - revoking the user session stops all of them.

## Found while building it

- **Flue's `write` tool retried the same write.** An approval is therefore keyed by the action (session, method, path, content), so a retry waits on the same approval instead of opening a second one.
- **`mkdir -p` of an existing folder** changes nothing, so it must not ask.

## What is simplified

- **Sub-agents** are started through the API with a `parent`. In the harness they start through a harness tool.
- **Capabilities** are minted fresh by the Workspace for each agent session, sub-agents included, and are linked by `parent` for revocation. Attenuating a Biscuit capability was proven in flue-capfs-do.
- **The file gate** knows two actions, read and write. Roles grant them through Datalog over the capability.
