// The gateway Worker: the HTTP surface of the prototype. In a real deployment it
// authenticates the user and looks up their rights; here admin routes need a bearer key
// (ADMIN_KEY secret, or DEV_ADMIN_KEY on a loopback host) and the session token is the user's
// bearer credential.
//
//   admin  POST /api/w/:ws/seed                    { files: { path: content } }
//   admin  GET  /api/w/:ws/files                   every file (audit)
//   admin  GET  /api/w/:ws/stats                   authorizations / verifications
//   admin  POST /api/w/:ws/sessions                { user, rights, mode } → { session, token }
//   admin  GET  /api/w/:ws/sessions/:sid
//   admin  POST /api/w/:ws/sessions/:sid/mode      { mode }
//   admin  POST /api/w/:ws/sessions/:sid/revoke    { rid? }
//   user   POST /api/agents/:name/run              { workspace, token, transport, chain?, task }
//   any    GET  /api/runtime                       which runtime answers

import { type AgentEnv, type AttenuationSpec, isolatesSeeHostFs, type Task } from "./agent.ts";
import type { CapHandoff } from "./caps.ts";
import { rebuildError } from "./path.ts";

export { Agent } from "./agent.ts";
export { Workspace } from "./workspace.ts";

interface Env extends AgentEnv {
  /** Admin bearer key for deployments: a secret (`wrangler secret put ADMIN_KEY`). */
  ADMIN_KEY?: string;
  /** Committed development key: honoured only for requests to a loopback host. */
  DEV_ADMIN_KEY?: string;
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

function sameBytes(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

/** Fail closed: without a configured key, admin routes are refused. */
function isAdmin(request: Request, env: Env): boolean {
  const auth = request.headers.get("authorization") ?? "";
  const given = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!given) return false;
  if (env.ADMIN_KEY && sameBytes(given, env.ADMIN_KEY)) return true;
  const host = new URL(request.url).hostname;
  return !!env.DEV_ADMIN_KEY && LOOPBACK.has(host) && sameBytes(given, env.DEV_ADMIN_KEY);
}

const STATUS: Record<string, number> = {
  EACCES: 403,
  EPERM: 403,
  ENOENT: 404,
  EINVAL: 400,
  ENOSYS: 501,
};

function fail(e: unknown): Response {
  const err = rebuildError(e);
  return Response.json(
    { ok: false, code: err.code, error: err.message },
    { status: STATUS[err.code] ?? 500 },
  );
}
// Identifies this process of the runtime (lazily: no random values at global scope in workerd),
// so a restart test can prove it talks to a NEW process.
let bootId: string | undefined;

const ok = (value: unknown) => Response.json({ ok: true, value: value ?? null });

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    try {
      if (parts[0] !== "api") return new Response("flue-capfs-do: see /api/*\n", { status: 404 });
      const body =
        request.method === "POST"
          ? ((await request.json().catch(() => ({}))) as Record<string, unknown>)
          : {};

      if (parts[1] === "runtime") {
        bootId ??= crypto.randomUUID();
        return ok({
          workerLoader: !!env.LOADER,
          // "isolated": tool isolates have no host file system; "refused": they would, so tool
          // tasks are refused (ALLOW_HOST_FS_TOOLS=1 overrides, for experiments only).
          toolIsolates: !env.LOADER
            ? "none"
            : isolatesSeeHostFs() && env.ALLOW_HOST_FS_TOOLS !== "1"
              ? "refused"
              : "isolated",
          userAgent: navigator.userAgent,
          bootId,
        });
      }

      if (parts[1] === "w" && parts[2]) {
        if (!isAdmin(request, env)) {
          return Response.json(
            { ok: false, code: "EACCES", error: "EACCES: admin key required" },
            { status: 401 },
          );
        }
        const ws = env.WORKSPACE.get(env.WORKSPACE.idFromName(parts[2]));
        const [, , , what, sid, action] = parts;
        if (what === "seed") return ok(await ws.seed(body.files as Record<string, string>));
        if (what === "files") return ok(await ws.dump());
        if (what === "stats") return ok(await ws.stats());
        if (what === "sessions" && !sid) {
          return ok(
            await ws.startSession(
              String(body.user ?? ""),
              (body.rights as string[]) ?? [],
              body.mode as string | undefined,
            ),
          );
        }
        if (what === "sessions" && sid && !action) return ok(await ws.sessionInfo(sid));
        if (what === "sessions" && sid && action === "mode")
          return ok(await ws.setMode(sid, String(body.mode)));
        if (what === "sessions" && sid && action === "revoke")
          return ok(await ws.revoke(sid, body.rid as string | undefined));
      }

      if (parts[1] === "agents" && parts[2] && parts[3] === "run") {
        const workspace = String(body.workspace ?? "");
        const token = String(body.token ?? "");
        let handoff: CapHandoff;
        if (body.transport === "token") handoff = { transport: "token", workspace, token };
        else {
          // The agent gets the capability by reference and never sees the token.
          const ws = env.WORKSPACE.get(env.WORKSPACE.idFromName(workspace));
          handoff = { transport: "stub", files: (await ws.open(token)) as never };
        }
        const agent = env.AGENT.get(env.AGENT.idFromName(parts[2]));
        return ok(
          await agent.run(
            parts[2],
            handoff,
            (body.chain as AttenuationSpec[]) ?? [],
            body.task as Task,
          ),
        );
      }
      return Response.json(
        { ok: false, code: "ENOENT", error: "ENOENT: no such route" },
        { status: 404 },
      );
    } catch (e) {
      return fail(e);
    }
  },
};
