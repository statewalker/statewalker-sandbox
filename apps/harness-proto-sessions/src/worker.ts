// PROTOTYPE (statewalker/statewalker-root#89). The session API, as decided in
// statewalker/statewalker-root#83, cut to what this prototype explores. The workspace is "acme".
//   POST /v1/login            { user, ttlMs? }   → { token }   (stands in for an identity provider)
//   GET  /v1/me                                   the user session (opened or resumed by the token)
//   PUT  /v1/me/mode          { mode }
//   POST /v1/me/revoke                            revoke the user session
//   POST /v1/sessions         { project, agent, parent? }      start an agent session
//   POST /v1/sessions/:id/messages { content }                 one turn
//   POST /v1/sessions/:id/archive                              revoke it and its sub-agents
//   POST /v1/approvals/:id    { decision: allow | deny, message? }
//   admin POST /admin/seed { files } · POST /admin/role { project, user, role|null } · GET /admin/file?path=

import type { Env as AgentEnv, AgentSession } from "./agent-session.ts";
import type { Issuer } from "./issuer.ts";
import type { Env as WorkspaceEnv } from "./workspace.ts";

export { AgentSession } from "./agent-session.ts";
export { Issuer } from "./issuer.ts";
export { Workspace } from "./workspace.ts";

interface Env extends AgentEnv, WorkspaceEnv {
  ISSUER: DurableObjectNamespace<Issuer>;
  AGENT: DurableObjectNamespace<AgentSession>;
  DEV_ADMIN_KEY?: string;
}

const WS = "acme";
const json = (v: unknown, status = 200) => Response.json(v, { status });
const fail = (e: unknown) => {
  const m = String((e as Error)?.message ?? e);
  const code = /(E[A-Z]+):/.exec(m)?.[1];
  const status = /expired|invalid access token/.test(m)
    ? 401
    : code === "EACCES"
      ? 403
      : code === "ENOENT"
        ? 404
        : code === "EINVAL"
          ? 400
          : 500;
  return json({ error: m }, status);
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean);
    const body =
      request.method === "GET"
        ? {}
        : ((await request.json().catch(() => ({}))) as Record<string, unknown>);
    const bearer = (request.headers.get("authorization") ?? "").replace(/^Bearer /, "");
    const ws = env.WORKSPACE.get(env.WORKSPACE.idFromName(WS));
    try {
      if (parts[0] === "admin") {
        if (bearer !== env.DEV_ADMIN_KEY) return json({ error: "admin only" }, 401);
        if (parts[1] === "seed") return json(await ws.seed(body.files as Record<string, string>));
        if (parts[1] === "role")
          return json(
            await ws.setRole(
              String(body.project),
              String(body.user),
              (body.role as string) ?? null,
            ),
          );
        if (parts[1] === "file") return json(await ws.dump(String(url.searchParams.get("path"))));
      }
      if (parts[0] !== "v1") return json({ error: "not found" }, 404);
      if (parts[1] === "login")
        return json(
          await env.ISSUER.get(env.ISSUER.idFromName("issuer")).login(
            String(body.user),
            WS,
            body.ttlMs as number | undefined,
          ),
        );
      if (parts[1] === "me") {
        if (parts[2] === "mode") return json(await ws.setMode(bearer, WS, String(body.mode)));
        if (parts[2] === "revoke") return json(await ws.revokeUserSession(bearer, WS));
        return json(await ws.me(bearer, WS));
      }
      if (parts[1] === "sessions") {
        const id = parts[2];
        if (!id) {
          const s = await ws.startAgentSession(bearer, WS, body as never);
          await env.AGENT.get(env.AGENT.idFromName(s.id)).configure({
            id: s.id,
            workspace: WS,
            project: s.project,
            agent: s.agent,
            tools: s.tools,
            capability: s.capability,
          });
          const { capability: _, ...visible } = s; // the capability never leaves the server
          return json(visible);
        }
        await ws.ownSession(bearer, WS, id); // the caller's own session, with a valid token
        if (parts[3] === "messages")
          return json(await env.AGENT.get(env.AGENT.idFromName(id)).run(String(body.content)));
        if (parts[3] === "archive") return json(await ws.archive(bearer, WS, id));
      }
      if (parts[1] === "approvals" && parts[2])
        return json(
          await ws.answer(
            bearer,
            WS,
            parts[2],
            body.decision === "allow",
            body.message as string | undefined,
          ),
        );
      return json({ error: "not found" }, 404);
    } catch (e) {
      return fail(e);
    }
  },
};
