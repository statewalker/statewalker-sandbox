// Start one runtime serving this Worker project, run the scenario suite against it, stop it.
//   node scripts/run-env.mjs wrangler | cellb | celld
//   node scripts/run-env.mjs cellb-celld-bucket   (cellb, cells stored in celld's format)
// celld: needs the `celld` binary on PATH or CELLD_BIN (https://github.com/denoland/celld
// releases, or the ghcr.io/denoland/celld image). Started as `celld dev --listen 127.0.0.1:<port>`;
// CELLD_ARGS overrides the arguments ("{port}" is replaced). TRANSPORTS=token skips the stub
// transport if the runtime refuses to pass RpcTargets by reference.
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const env = process.argv[2];
const dir = fileURLToPath(new URL("..", import.meta.url));
const freePort = () =>
  new Promise((resolve) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
const port = Number(process.env.PORT ?? (await freePort()));
const state = mkdtempSync(join(tmpdir(), `flue-capfs-${env}-`));

const commands = {
  wrangler: [
    "npx",
    [
      "wrangler",
      "dev",
      "--port",
      String(port),
      "--ip",
      "127.0.0.1",
      "--persist-to",
      state,
      "--show-interactive-dev-session=false",
    ],
  ],
  cellb: ["node", ["scripts/serve-cellb.mjs", "--port", String(port), "--data", state]],
  // cellb with its cells in celld's bucket format (the object store `celld dev` keeps).
  "cellb-celld-bucket": [
    "node",
    [
      "scripts/serve-cellb.mjs",
      "--port",
      String(port),
      "--celld-bucket",
      join(state, "objects.sqlite3"),
    ],
  ],
  // celld: CELLD_BIN (default `celld` on PATH); CELLD_ARGS replaces the default arguments.
  celld: [
    process.env.CELLD_BIN ?? "celld",
    process.env.CELLD_ARGS
      ? process.env.CELLD_ARGS.replaceAll("{port}", String(port)).split(" ")
      : ["dev", "--listen", `127.0.0.1:${port}`],
  ],
};
if (!commands[env]) {
  console.error(`usage: run-env.mjs ${Object.keys(commands).join(" | ")}`);
  process.exit(2);
}
const [cmd, args] = commands[env];
const base = `http://127.0.0.1:${port}`;

async function startRuntime() {
  const child = spawn(cmd, args, {
    cwd: dir,
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
    detached: true,
  });
  child.log = "";
  child.stdout.on("data", (d) => (child.log += d));
  child.stderr.on("data", (d) => (child.log += d));
  const failed = new Promise((_, reject) =>
    child.on("error", (e) => reject(new Error(`cannot start '${cmd}': ${e.message}`))),
  );
  const ready = (async () => {
    const deadline = Date.now() + 120_000;
    for (;;) {
      try {
        if ((await fetch(`${base}/api/runtime`)).ok) return;
      } catch {}
      if (child.exitCode !== null || Date.now() > deadline)
        throw new Error(`did not start\n${child.log}`);
      await new Promise((r) => setTimeout(r, 500));
    }
  })();
  await Promise.race([ready, failed]);
  return child;
}
async function stopRuntime(child) {
  const portFree = async () => {
    try {
      await fetch(`${base}/api/runtime`, { signal: AbortSignal.timeout(1000) });
      return false;
    } catch {
      return true;
    }
  };
  // The whole process group: wrangler starts workerd children.
  for (const signal of ["SIGINT", "SIGTERM", "SIGKILL"]) {
    try {
      process.kill(-child.pid, signal);
    } catch {}
    for (let i = 0; i < 20; i++) {
      if (child.exitCode !== null && (await portFree())) return;
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  if (!(await portFree())) throw new Error(`${env}: still answering on ${base} after SIGKILL`);
}
function runTests(file, extraEnv = {}) {
  const t = spawn(process.execPath, ["--test", "--test-reporter=spec", file], {
    cwd: dir,
    stdio: "inherit",
    env: { ...process.env, BASE_URL: base, ...extraEnv },
  });
  return new Promise((r) => t.on("exit", r));
}

let child;
try {
  child = await startRuntime();
} catch (e) {
  console.error(`${env}: ${e.message}`);
  process.exit(3);
}
console.log(`${env}: ready on ${base} (state: ${state})`);
const durability = { DURABILITY_FILE: join(state, "durability.json") };
let code = await runTests("tests/scenario.test.mjs");
code ||= await runTests("tests/durability.test.mjs", { ...durability, PHASE: "write" });
await stopRuntime(child);
if (!code) {
  console.log(`${env}: restarted on the same state`);
  child = await startRuntime();
  code = await runTests("tests/durability.test.mjs", { ...durability, PHASE: "check" });
  await stopRuntime(child);
}
if (code !== 0 && process.env.SHOW_LOG) console.log(child.log);
process.exit(code ?? 1);
