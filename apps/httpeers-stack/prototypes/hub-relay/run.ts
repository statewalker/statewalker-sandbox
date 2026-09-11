// PROTOTYPE (hub-relay) -- the scripted run. Throwaway; see README.md.
// pnpm --filter @statewalker/httpeers-stack proto:hub-relay
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { networkInterfaces, tmpdir } from "node:os";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Page } from "playwright";
import { build } from "vite";
import { startRelay } from "../../src/relay/main.js";
import { loadOrGenerateKey } from "../../src/setup/keys.js";

const here = fileURLToPath(new URL(".", import.meta.url));
const TURN_CONTAINER = "proto-hub-relay-turn";
const MiB = 1024 * 1024;

const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const step = (s: string) => console.log(`\n${bold(`== ${s}`)}`);
const show = (label: string, value: unknown) =>
  console.log(`${bold(label)} ${JSON.stringify(value, null, 1).replace(/\n\s*/g, " ")}`);

function lanIp(): string {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) if (a.family === "IPv4" && !a.internal) return a.address;
  }
  throw new Error("no non-loopback IPv4 address for TURN");
}

function serve(dir: string): Promise<{ server: Server; url: string }> {
  const types: Record<string, string> = { ".html": "text/html", ".js": "text/javascript" };
  const server = createServer((req, res) => {
    const path = req.url === "/" ? "/index.html" : (req.url ?? "/").split("?")[0];
    try {
      const body = readFileSync(join(dir, path));
      res.writeHead(200, { "content-type": types[extname(path)] ?? "application/octet-stream" });
      res.end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr == null || typeof addr === "string") throw new Error("no port");
      resolve({ server, url: `http://127.0.0.1:${addr.port}/` });
    }),
  );
}

// biome-ignore lint/suspicious/noExplicitAny: the page API is untyped on purpose -- throwaway.
type Proto = any;
const call = <T = unknown>(page: Page, method: string, ...args: unknown[]): Promise<T> =>
  page.evaluate(
    ([m, a]) => (globalThis as unknown as { proto: Proto }).proto[m as string](...(a as unknown[])),
    [method, args] as const,
  ) as Promise<T>;

const attempt = async (page: Page, method: string, ...args: unknown[]) => {
  try {
    return { ok: true, result: await call(page, method, ...args) };
  } catch (err) {
    return { ok: false, error: String((err as Error).message).split("\n")[0] };
  }
};

async function until(check: () => Promise<boolean>, what: string, ms = 15_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`timed out waiting for: ${what}`);
}

type PcStat = {
  index: number;
  state: string;
  local?: string;
  remote?: string;
  bytesSent: number;
  bytesReceived: number;
};
const hubPcs = async (hub: Page) =>
  (await call<{ peerConnections: PcStat[] }>(hub, "state")).peerConnections.map(
    (pc) =>
      `#${pc.index} ${pc.state} ${pc.local}/${pc.remote} ↑${pc.bytesSent} ↓${pc.bytesReceived}`,
  );

async function main(): Promise<void> {
  const tmp = mkdtempSync(join(tmpdir(), "proto-hub-relay-"));
  const ip = lanIp();
  const cleanups: Array<() => Promise<void> | void> = [
    () => rmSync(tmp, { recursive: true, force: true }),
  ];

  try {
    step("infrastructure");
    execFileSync("docker", ["rm", "-f", TURN_CONTAINER], { stdio: "ignore" });
    execFileSync(
      "docker",
      [
        "run",
        "-d",
        "--rm",
        "--name",
        TURN_CONTAINER,
        "--network",
        "host",
        "coturn/coturn:4.6",
        "-n",
        "--log-file=stdout",
        "--no-cli",
        "--no-tls",
        "--no-dtls",
        `--listening-ip=${ip}`,
        "--listening-port=3478",
        `--relay-ip=${ip}`,
        "--min-port=49160",
        "--max-port=49200",
        "--lt-cred-mech",
        "--user=proto:proto",
        "--realm=proto",
      ],
      { stdio: "ignore" },
    );
    cleanups.push(() => {
      const log = execFileSync("docker", ["logs", TURN_CONTAINER], { encoding: "utf8" });
      console.log(
        dim(
          `coturn: ${log.split("\n").filter((l) => /allocation|error|denied|401|403|ALLOCATE|CREATE_PERMISSION|CHANNEL/i.test(l)).length} allocation/permission log lines; last:`,
        ),
      );
      for (const l of log.trim().split("\n").slice(-6)) console.log(dim(`  ${l}`));
      execFileSync("docker", ["rm", "-f", TURN_CONTAINER], { stdio: "ignore" });
    });
    const turn: RTCIceServer = {
      urls: `turn:${ip}:3478?transport=udp`,
      username: "proto",
      credential: "proto",
    };
    console.log(dim(`TURN  turn:${ip}:3478 (coturn, container ${TURN_CONTAINER})`));

    const keyPath = join(tmp, "relay.key");
    await loadOrGenerateKey({ keyPath, seed: "proto/hub-relay/relay" });
    const relay = await startRelay({ port: 0, keyPath });
    cleanups.push(() => relay.stop());
    const relayAddr = relay.node
      .getMultiaddrs()
      .map(String)
      .find((a) => a.startsWith("/ip4/127.0.0.1/"));
    if (relayAddr == null) throw new Error("relay has no loopback address");
    console.log(dim(`relay ${relayAddr}`));

    const outDir = join(tmp, "page");
    await build({
      root: join(here, "page"),
      base: "./",
      logLevel: "warn",
      resolve: { conditions: ["source", "browser", "import", "module", "default"] },
      build: { target: "esnext", outDir, emptyOutDir: true, minify: false },
    });
    const { server, url } = await serve(outDir);
    cleanups.push(() => new Promise<void>((r) => server.close(() => r())));

    const browser = await chromium.launch();
    cleanups.push(() => browser.close());
    const open = async (name: string): Promise<Page> => {
      const page = await (await browser.newContext()).newPage();
      page.on("console", (m) => {
        if (m.type() === "error" || m.type() === "warning")
          console.log(dim(`[${name}:${m.type()}] ${m.text()}`));
      });
      page.on("pageerror", (e) => console.log(dim(`[${name}:pageerror] ${e.message}`)));
      await page.goto(url);
      await page.waitForFunction(() => "proto" in globalThis);
      return page;
    };
    const [hub, a, b, c] = await Promise.all(["hub", "A", "B", "C"].map(open));

    step("the hub reserves on the public relay; members and an outsider reach it over WebRTC");
    const H = await call<string>(hub, "start", { role: "hub" });
    await call(hub, "dial", relayAddr);
    await until(
      async () => (await call<{ circuitAddrs: number }>(hub, "state")).circuitAddrs > 0,
      "hub reservation",
    );
    const hubAddr = `${relayAddr}/p2p-circuit/webrtc/p2p/${H}`;
    const [A, B, C] = await Promise.all(
      [a, b, c].map((p) => call<string>(p, "start", { role: "member" })),
    );
    for (const [name, page] of [
      ["A", a],
      ["B", b],
      ["C", c],
    ] as const) {
      show(`${name} → hub`, await attempt(page, "dial", hubAddr));
      show(`${name} drops the signalling circuit`, await attempt(page, "dropLimited", H));
    }
    await call(hub, "allow", A);
    await call(hub, "allow", B);
    console.log(
      dim(
        `hub …${H.slice(-6)}  A …${A.slice(-6)}  B …${B.slice(-6)}  C …${C.slice(-6)} (not a member)`,
      ),
    );

    step("A and B reserve on the hub, over their WebRTC link to it");
    show("A reserve", await attempt(a, "reserveOn", H));
    show("B reserve", await attempt(b, "reserveOn", H));

    step(
      "Q1  A dials B through the hub — does it end direct, with the hub carrying only signalling?",
    );
    const viaHubWebrtc = `/p2p/${H}/p2p-circuit/webrtc/p2p/${B}`;
    show("A → B", await attempt(a, "dial", viaHubWebrtc));
    show("hub PCs before", await hubPcs(hub));
    const recvBefore = (await call<Record<string, number>>(b, "received"))["/proto/sink/1.0.0"];
    show("A sinks 4 MiB to B", await attempt(a, "sink", B, 4 * MiB, { over: "unlimited" }));
    await until(
      async () =>
        (await call<Record<string, number>>(b, "received"))["/proto/sink/1.0.0"] - recvBefore >=
        4 * MiB,
      "B receives 4 MiB",
    ).catch((e) => console.log(e.message));
    show("B received", await call(b, "received"));
    show("hub PCs after", await hubPcs(hub));
    show("A state", await call(a, "state"));

    step("Q3  outsider C: reserve on the hub, then be relayed to B");
    show("C reserve", await attempt(c, "reserveOn", H));
    show("C → B via hub", await attempt(c, "dial", viaHubWebrtc));
    await call(hub, "allow", C);
    show("control: C admitted, reserves again", await attempt(c, "reserveOn", H));
    show("control: C → B via hub", await attempt(c, "dial", viaHubWebrtc));
    await call(c, "hangUp", B);

    step("Q2a  no direct path, no TURN — does data flow over the hub?");
    for (const p of [a, b])
      await call(p, "setIce", { iceServers: [], iceTransportPolicy: "relay" });
    await call(a, "hangUp", B);
    show("A → B webrtc (must fail)", await attempt(a, "dial", viaHubWebrtc));
    show("A → B bare circuit", await attempt(a, "dial", `/p2p/${H}/p2p-circuit/p2p/${B}`));
    show(
      "app protocol over the hub circuit",
      await attempt(a, "sink", B, MiB, { over: "limited" }),
    );
    show(
      "…forced with runOnLimitedConnection",
      await attempt(a, "sink", B, MiB, { over: "limited", forceLimited: true }),
    );
    await new Promise((r) => setTimeout(r, 1_000));
    show("B received", await call(b, "received"));

    step("Q2b  no direct path, TURN available — does data flow through TURN?");
    for (const p of [a, b])
      await call(p, "setIce", { iceServers: [turn], iceTransportPolicy: "relay" });
    await call(a, "hangUp", B);
    show("A → B webrtc", await attempt(a, "dial", viaHubWebrtc));
    show("hub PCs before", await hubPcs(hub));
    const recvBefore2 = (await call<Record<string, number>>(b, "received"))["/proto/sink/1.0.0"];
    show("A sinks 4 MiB to B", await attempt(a, "sink", B, 4 * MiB, { over: "unlimited" }));
    await until(
      async () =>
        (await call<Record<string, number>>(b, "received"))["/proto/sink/1.0.0"] - recvBefore2 >=
        4 * MiB,
      "B receives 4 MiB via TURN",
    ).catch((e) => console.log(e.message));
    show("B received", await call(b, "received"));
    show("hub PCs after", await hubPcs(hub));
    show("A state", await call(a, "state"));
  } finally {
    for (const cleanup of cleanups.reverse()) await Promise.resolve(cleanup()).catch(() => {});
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
