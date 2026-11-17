// PROTOTYPE (statewalker/statewalker-root#90). The HTTP surface.
//   admin POST /admin/w/:ws/seed              { files }            files into the store
//   admin POST /admin/w/:ws/members/:project  { user: role, ... }  the project's access file
//   POST /v1/sessions        { workspace, user, project, agent, mode } → { id, tools }
//         (stands in for the user session: mints the user's workspace capability for the project
//          and takes their role from the access file)
//   GET  /v1/sessions/:id/tools                 offered, absent (why), definitions
//   PUT  /v1/sessions/:id/mode   { mode }
//   POST /v1/sessions/:id/messages { content }  one turn of Flue's loop
//   POST /v1/sessions/:id/mcp    JSON-RPC       the session's own MCP endpoint
//   POST /v1/sessions/:id/approvals/:aid { decision: allow | deny }
//   GET  /v1/catalog                            every definition, before narrowing

import type { Env } from "./agent-session.ts";

export { AgentSession } from "./agent-session.ts";
export { Workspace } from "./workspace.ts";

const json = (v: unknown, status = 200) => Response.json(v, { status });
const fail = (e: unknown) => {
  const m = String((e as Error)?.message ?? e);
  const code = /^(?:Error: )?(E[A-Z]+)/.exec(m)?.[1];
  return json(
    { error: m },
    code === "EACCES" ? 403 : code === "ENOENT" ? 404 : code === "EINVAL" ? 400 : 500,
  );
};

export default {
  async fetch(request: Request, env: Env & { DEV_ADMIN_KEY?: string }): Promise<Response> {
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean);
    const body =
      request.method === "GET"
        ? {}
        : ((await request.json().catch(() => ({}))) as Record<string, unknown>);
    const admin = request.headers.get("authorization") === `Bearer ${env.DEV_ADMIN_KEY}`;
    const ws = (name: string) => env.WORKSPACE.get(env.WORKSPACE.idFromName(name));
    const session = (id: string) => env.AGENT.get(env.AGENT.idFromName(id));
    try {
      if (parts[0] === "admin") {
        if (!admin) return json({ error: "admin only" }, 401);
        const [, , name, what, project] = parts;
        if (what === "seed")
          return json(await ws(String(name)).seed(body.files as Record<string, string>));
        if (what === "members" && project) {
          const w = ws(String(name));
          const { token } = await w.startSession("admin", ["/"], "yolo");
          const out = {};
          for (const [user, role] of Object.entries(body))
            Object.assign(out, await w.harnessTool("members.add", project, token, { user, role }));
          return json(out);
        }
      }
      if (parts[0] === "v1" && parts[1] === "catalog") {
        // any session cell can read the catalog; use a scratch one
        return json(await session("catalog").catalog());
      }
      if (parts[0] === "v1" && parts[1] === "sessions") {
        const id = parts[2];
        if (!id && request.method === "POST") {
          const { workspace, user, project, agent, mode } = body as Record<string, string>;
          const w = ws(workspace);
          const { token } = await w.startSession(user, [`/${project}`], "yolo");
          const { members } = (await w.harnessTool("members.list", project, token, {})) as {
            members: Record<string, string>;
          };
          const role = members[user];
          if (!role) return json({ error: `EACCES: ${user} is not a member of ${project}` }, 403);
          const sid = crypto.randomUUID();
          const tools = await session(sid).configure({
            workspace,
            token,
            project,
            user,
            role,
            agent,
            mode: mode ?? "default",
          });
          return json({ id: sid, role, tools });
        }
        if (!id) return json({ error: "not found" }, 404);
        const s = session(id);
        const what = parts[3];
        if (what === "tools") return json(await s.tools());
        if (what === "mode") return json(await s.setMode(String(body.mode)));
        if (what === "messages") return json(await s.run(String(body.content)));
        if (what === "mcp") return json(await s.mcp(body as never));
        if (what === "approvals" && parts[4])
          return json(await s.approve(parts[4], body.decision === "allow"));
      }
      return json({ error: "not found" }, 404);
    } catch (e) {
      return fail(e);
    }
  },
};
