// The gateway Worker: the HTTP surface of the prototype. In a real deployment it
// authenticates the user and looks up their rights; here admin routes need a bearer key
// (ADMIN_KEY secret, or DEV_ADMIN_KEY on a loopback host) and the session token is the user's
// bearer credential.
//
//   admin  POST /api/w/:ws/seed                    { files: { path: content } }
//   admin  GET  /api/w/:ws/files[?encoding=base64] every file (audit; bytes as base64)
//   admin  GET  /api/w/:ws/stats                   authorizations / verifications
//   admin  POST /api/w/:ws/sessions                { user, rights, mode, model? } → { session, token }
//          (model: false (default), true, or a budget { turns?, tokens? })
//   admin  GET  /api/w/:ws/sessions/:sid
//   admin  POST /api/w/:ws/sessions/:sid/mode      { mode }
//   admin  POST /api/w/:ws/sessions/:sid/revoke    { rid? }
//   admin  POST /api/w/:ws/sessions/:sid/model     { turns?, tokens? }  what is left (absent: unlimited)
//   user   POST /api/agents/:name/run              { workspace, token, transport, chain?, task }
//   any    GET  /api/runtime                       which runtime answers

// Must stay the first import (a side-effect import, so it is not sorted): see node-probe-guard.ts.
import "./node-probe-guard.ts";
import type { AgentEnv, AttenuationSpec, Task } from "./agent.ts";
import type { CapHandoff } from "./caps.ts";
import { llmConfig } from "./llm-config.ts";
import { restoreNodeVersions } from "./node-probe-guard.ts";
import { rebuildError } from "./path.ts";
import { pythonRuntime } from "./python/hosts.ts";
import { bundlerOffered } from "./tools/bundler-client.ts";
import { deploymentToolConfig } from "./tools/config.ts";
import { toolPolicy } from "./tools/policy.ts";
import { wasmerHost } from "./wasmer/kernel.ts";

export { Agent } from "./agent.ts";
export { ToolFilesEntrypoint } from "./tool-files-entrypoint.ts";
export { Workspace } from "./workspace.ts";

restoreNodeVersions();

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
  EFBIG: 413,
  ENOSYS: 501,
};

function fail(e: unknown): Response {
  const err = rebuildError(e);
  return Response.json(
    { ok: false, code: err.code, error: err.message },
    { status: STATUS[err.code] ?? 500 },
  );
}

/** Where the `wasmer` task runs here ("node", "browser"), or why it does not. */
function wasmerSummary(env: Env): string {
  try {
    wasmerHost(env);
    return pythonRuntime();
  } catch (e) {
    return String((e as Error).message);
  }
}

/** Which model the `agent` task uses (never the key). */
function llmSummary(env: Env) {
  try {
    const c = llmConfig(env);
    return c
      ? {
          model: c.model,
          api: c.api ?? "openai-completions",
          host: new URL(c.baseUrl).host,
          // Whether callers may (or must) bring their own model token (x-llm-token).
          callerToken: c.callerToken ?? "allow",
          // Whether it goes to a gateway beside the deployment's key, or is the provider key.
          callerTokenHeader: !!c.callerTokenHeader,
          callerTokenUnmetered: !!c.callerTokenUnmetered,
        }
      : null;
  } catch (e) {
    return { error: String((e as Error).message) };
  }
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
        let tools: Record<string, unknown>;
        try {
          const config = deploymentToolConfig(env.TOOL_BUNDLE);
          // How tool tasks are treated here: none | isolated | bundled-only | refused (see toolPolicy).
          tools = {
            toolIsolates: toolPolicy(env, config),
            requireBundled: config.requireBundled,
            allowedBundles: config.allowedBundles.length,
          };
        } catch (e) {
          tools = { toolIsolates: "refused", toolConfigError: String((e as Error).message) };
        }
        return ok({
          workerLoader: !!env.LOADER,
          python: env.PYTHON === "off" ? "off" : pythonRuntime(),
          llm: llmSummary(env),
          // Whether tools can be bundled in the deployment (the bundler Worker, on demand).
          bundler: bundlerOffered(env),
          // Where Wasmer sandboxes run ("node", "browser"), or why not.
          wasmer: wasmerSummary(env),
          ...tools,
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
        if (what === "seed")
          return ok(await ws.seed(body.files as Record<string, string | { $b64: string }>));
        if (what === "files")
          return ok(
            await ws.dump(url.searchParams.get("encoding") === "base64" ? "base64" : undefined),
          );
        if (what === "stats") return ok(await ws.stats());
        if (what === "sessions" && !sid) {
          return ok(
            await ws.startSession(
              String(body.user ?? ""),
              (body.rights as string[]) ?? [],
              body.mode as string | undefined,
              body.model as never,
            ),
          );
        }
        if (what === "sessions" && sid && !action) return ok(await ws.sessionInfo(sid));
        if (what === "sessions" && sid && action === "mode")
          return ok(await ws.setMode(sid, String(body.mode)));
        if (what === "sessions" && sid && action === "revoke")
          return ok(await ws.revoke(sid, body.rid as string | undefined));
        if (what === "sessions" && sid && action === "model")
          return ok(await ws.setModelBudget(sid, body as never));
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
            undefined,
            // The caller's model credential: a header, so it stays out of logged bodies.
            request.headers.get("x-llm-token") || undefined,
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
