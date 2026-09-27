/**
 * A whole httpeers mesh on loopback, for the e2e tests and for trying the app
 * by hand: a circuit relay, the Node hub daemon with its `llm` service, a fake
 * LiteLLM behind it, and a plain HTTP server for the proxy to expose.
 *
 *   node tools/mesh-stack.mjs [appUrl]     # prints invitations for appUrl (default http://127.0.0.1:3000/)
 *
 * The e2e tests run it as a child process (`app/tests/mesh-stack.ts`) and use
 * its control endpoint: Playwright loads specs as CommonJS, which cannot
 * import this module.
 *
 * NOTHING HERE TOUCHES THE PUBLIC INTERNET. It is the shape of
 * `httpeers/apps/hub/tests/ui.e2e.mjs`: the relay document is served locally,
 * and the door (the hub's admin HTTP entry, normally behind Traefik) is called
 * with its secret the way the reverse proxy would.
 *
 * The httpeers checkout is `$HTTPEERS_DIR`, by default next to this
 * repository (`../httpeers`), and must be built: `pnpm install && pnpm -r build`.
 */
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
export const HTTPEERS_DIR = resolve(process.env.HTTPEERS_DIR ?? join(here, "../../../../httpeers"));

const DOOR_SECRET = "theia-shell-e2e-door-secret-0123456789";
const MASTER_KEY = "sk-fake-master";

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server.address().port;
}

async function freePort() {
  const server = createNetServer();
  const port = await listen(server);
  await new Promise((done) => server.close(done));
  return port;
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/**
 * LiteLLM as the hub's `llm` module sees it: every path is under
 * `/peers/<hubPeerId>/llm/`. Keys are minted with the master key and then
 * required on `v1/*`; the reply streams one SSE event per word.
 */
function fakeLiteLlm() {
  const keys = new Set();
  const stats = { completions: 0, lastModel: null };
  const server = createServer(async (req, res) => {
    const path = new URL(req.url, "http://x").pathname.replace(/^\/peers\/[^/]+\/llm/, "");
    const key = (req.headers["x-litellm-api-key"] ?? "").replace(/^Bearer /, "");
    const json = (status, body) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    let body = "";
    for await (const chunk of req) body += chunk;

    if (path === "/key/generate" && req.method === "POST") {
      if (key !== MASTER_KEY) return json(401, { error: { message: "not the master key" } });
      const minted = `sk-fake-${keys.size + 1}`;
      keys.add(minted);
      return json(200, { key: minted, key_alias: JSON.parse(body || "{}").key_alias ?? null });
    }
    if (!keys.has(key)) return json(401, { error: { message: "invalid api key" } });
    if (path === "/v1/models" && req.method === "GET") {
      return json(200, { object: "list", data: [{ id: "fake-beta" }, { id: "fake-alpha" }] });
    }
    if (path === "/v1/chat/completions" && req.method === "POST") {
      const request = JSON.parse(body);
      const last = request.messages.at(-1)?.content ?? "";
      stats.completions += 1;
      stats.lastModel = request.model;
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const word of `Reply to "${last}" from ${request.model}.`.split(" ")) {
        const delta = { choices: [{ index: 0, delta: { content: `${word} ` } }] };
        res.write(`data: ${JSON.stringify(delta)}\n\n`);
        await sleep(20);
      }
      res.end("data: [DONE]\n\n");
      return;
    }
    json(404, { error: { message: `fake LiteLLM has no ${req.method} ${path}` } });
  });
  return { server, keys, stats };
}

/**
 * What the proxy exposes: echoes the path and whether the mesh's own headers
 * were stripped. It answers CORS, as any upstream of a browser-hosted proxy
 * must: the proxying member's page is the one that fetches it.
 */
function outsideOrigin() {
  const cors = {
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "*",
    "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
  };
  return createServer((req, res) => {
    if (req.method === "OPTIONS") {
      res.writeHead(204, cors).end();
      return;
    }
    res.writeHead(200, { ...cors, "content-type": "application/json" });
    res.end(
      JSON.stringify({
        hello: "from the outside origin",
        path: req.url,
        apiKey: req.headers["x-api-key"] ?? null,
        sawMeshToken: req.headers["x-httpeers-token"] != null,
      }),
    );
  });
}

export async function startMeshStack({ joinPageUrl = "http://127.0.0.1:3000/" } = {}) {
  const dist = (p) => pathToFileURL(join(HTTPEERS_DIR, p)).href;
  for (const p of ["apps/relay/dist/index.js", "apps/hub/dist/daemon.js"]) {
    if (!existsSync(join(HTTPEERS_DIR, p))) {
      throw new Error(
        `mesh-stack: ${join(HTTPEERS_DIR, p)} is missing; build httpeers first (pnpm -r build)`,
      );
    }
  }
  const { generateRelayKey, startRelay } = await import(dist("apps/relay/dist/index.js"));
  const { startDaemon } = await import(dist("apps/hub/dist/daemon.js"));
  const { llmModule } = await import(dist("apps/hub/dist/services/llm/index.js"));

  const dataDir = await mkdtemp(join(tmpdir(), "theia-shell-mesh-"));
  const relay = await startRelay({
    privateKey: await generateRelayKey(join(dataDir, "relay.key")),
    port: 0,
  });
  const relayAddrs = relay.node
    .getMultiaddrs()
    .map((addr) => addr.toString())
    .filter((addr) => addr.startsWith("/ip4/127.0.0.1/"));
  const relayDoc = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ relayAddrs }));
  });
  const relayDocPort = await listen(relayDoc);

  const llm = fakeLiteLlm();
  const llmPort = await listen(llm.server);
  const outside = outsideOrigin();
  const outsidePort = await listen(outside);

  const doorPort = await freePort();
  const daemon = await startDaemon(
    {
      dataDir,
      relayDoc: `http://127.0.0.1:${relayDocPort}/.well-known/httpeers-relay.json`,
      services: ["llm"],
      joinPageUrl,
      localDoorPort: doorPort,
      localDoorHost: "127.0.0.1",
      doorSecret: DOOR_SECRET,
      doorAllowedHosts: [`127.0.0.1:${doorPort}`],
    },
    [llmModule({ upstream: `http://127.0.0.1:${llmPort}`, masterKey: MASTER_KEY })],
  );

  /** A fresh invitation link, minted through the door as the operator would. */
  async function invitation(role = "admin") {
    const res = await fetch(`http://127.0.0.1:${doorPort}/hub/api/invitations`, {
      method: "POST",
      headers: { "x-hub-door-secret": DOOR_SECRET, "content-type": "application/json" },
      body: JSON.stringify({ roles: [role] }),
    });
    if (!res.ok)
      throw new Error(
        `mesh-stack: minting an ${role} invitation: HTTP ${res.status} ${await res.text()}`,
      );
    return (await res.json()).link;
  }

  return {
    hubPeerId: daemon.hubPeerId,
    outsideUrl: `http://127.0.0.1:${outsidePort}`,
    llmStats: llm.stats,
    invitation,
    async stop() {
      await daemon.revocationsFlushed?.().catch(() => {});
      await daemon.stop();
      await relay.stop();
      for (const server of [relayDoc, llm.server, outside]) server.close();
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

/** No top-level await: the tests load this module with `require`. */
async function main() {
  const appUrl = process.argv[2] ?? "http://127.0.0.1:3000/";
  const stack = await startMeshStack({ joinPageUrl: appUrl });
  console.log(`hub      ${stack.hubPeerId}`);
  console.log(`outside  ${stack.outsideUrl}   (a proxy upstream to try)`);
  console.log(`admin    ${await stack.invitation("admin")}`);
  console.log(`member   ${await stack.invitation("member")}`);
  // While it runs: GET /invite?role=member|admin answers a fresh link, GET /stats the fake LLM's counters.
  const control = createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    try {
      if (url.pathname === "/stats") res.end(JSON.stringify(stack.llmStats));
      else res.end(await stack.invitation(url.searchParams.get("role") ?? "member"));
    } catch (error) {
      res.writeHead(500).end(String(error));
    }
  });
  const controlUrl = `http://127.0.0.1:${await listen(control)}`;
  console.log(`invite   ${controlUrl}/invite?role=member   (a fresh link per GET)`);
  console.log(`control  ${controlUrl}`);
  console.log("Ctrl+C stops the stack.");
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => stack.stop().finally(() => process.exit(0)));
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
