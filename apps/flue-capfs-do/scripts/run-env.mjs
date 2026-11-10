// Start one runtime serving this Worker project, run the scenario suite against it, stop it.
//   node scripts/run-env.mjs wrangler | cellb | celld
//   node scripts/run-env.mjs cellb-celld-bucket   (cellb, cells stored in celld's format)
// celld: CELLD_BIN, or (default) the ghcr.io/denoland/celld:0.6.0 image in Docker (CELLD_IMAGE),
// started as `celld dev <project> --host 127.0.0.1 --port <port> --no-watch`. It runs with
// TRANSPORTS=token: celld does not pass RpcTargets between isolates ("RPC stubs cannot cross
// isolate boundaries yet").
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { bundleTodoTool } from "../tests/fixtures/bundle-fixture.mjs";
import { startFakeLlm } from "../tests/helpers/fake-llm.mjs";
import { startWasmServer } from "../tests/helpers/wasm-server.mjs";
import { buildBundler } from "./build-bundler.mjs";

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
// The `agent` task's model: a fake OpenAI-compatible endpoint (tests/helpers/fake-llm.mjs),
// given to the runtime as the LLM var, with a dummy key.
const fakeLlm = await startFakeLlm();
const LLM = JSON.stringify(fakeLlm.config);
// The bundler Worker: its program is generated before the runtime builds the project, and
// esbuild.wasm is served locally as the deployment's BUNDLER_WASM_URL.
await buildBundler({ quiet: true });
const wasmServer = await startWasmServer();
const LLM_VARS = [`LLM=${LLM}`, "LLM_API_KEY=sk-fake", `BUNDLER_WASM_URL=${wasmServer.url}`];

const DEV_VARS_MARK = "# written by scripts/run-env.mjs for a test run (removed when it ends)";
let ownDevVars = false;

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
      ...LLM_VARS.flatMap((v) => ["--var", v.replace("=", ":")]),
    ],
  ],
  cellb: [
    "node",
    [
      "scripts/serve-cellb.mjs",
      "--port",
      String(port),
      "--data",
      state,
      ...LLM_VARS.flatMap((v) => ["--var", v]),
    ],
  ],
  // cellb with its cells in celld's bucket format (the object store `celld dev` keeps).
  "cellb-celld-bucket": [
    "node",
    [
      "scripts/serve-cellb.mjs",
      "--port",
      String(port),
      "--celld-bucket",
      join(state, "objects.sqlite3"),
      ...LLM_VARS.flatMap((v) => ["--var", v]),
    ],
  ],
  // cellb, accepting APPROVED bundles: the fixture tool's hash is the one allowed bundle.
  "cellb-bundled-only": async () => {
    const { hash } = await bundleTodoTool();
    const toolBundle = JSON.stringify({ hostFsRuntimes: "bundled-only", allowedBundles: [hash] });
    return [
      "node",
      [
        "scripts/serve-cellb.mjs",
        "--port",
        String(port),
        "--data",
        state,
        "--var",
        `TOOL_BUNDLE=${toolBundle}`,
        ...LLM_VARS.flatMap((v) => ["--var", v]),
      ],
    ];
  },
  // celld: CELLD_BIN if set, else the image CELLD_IMAGE (default ghcr.io/denoland/celld:0.6.0)
  // in Docker with host networking and the repository mounted at its own path (pnpm's links).
  // celld bundles with esbuild: the project's own native esbuild is passed as CELLD_ESBUILD.
  celld: () => {
    // celld reads Worker vars from .dev.vars beside the config. A developer's own file (it
    // usually holds wrangler dev secrets) is never overwritten: only one this script wrote, which
    // a killed run can leave behind. It is removed when the run ends.
    const devVars = join(dir, ".dev.vars");
    if (existsSync(devVars) && !readFileSync(devVars, "utf8").startsWith(DEV_VARS_MARK)) {
      console.error(`celld: ${devVars} exists; move it away for the test run`);
      process.exit(2);
    }
    if (LLM_VARS.some((v) => v.includes("'"))) throw new Error("a var contains a single quote");
    writeFileSync(
      devVars,
      `${DEV_VARS_MARK}\n${LLM_VARS.map((v) => `${v.replace("=", "='")}'`).join("\n")}\n`,
    );
    ownDevVars = true;
    const args = ["dev", dir, "--host", "127.0.0.1", "--port", String(port), "--no-watch"];
    if (process.env.CELLD_BIN) return [process.env.CELLD_BIN, args];
    if (process.platform !== "linux") {
      // The image needs a Linux esbuild, and pnpm installs only this host's platform package;
      // Docker Desktop also needs host networking turned on (4.34+) for --network host.
      console.error(
        "celld in Docker needs a Linux host here: set CELLD_BIN to a local celld instead",
      );
      process.exit(2);
    }
    const repo = join(dir, "../..");
    const fromApp = createRequire(join(dir, "package.json"));
    const esbuildBin = createRequire(fromApp.resolve("esbuild")).resolve(
      `@esbuild/linux-${process.arch}/bin/esbuild`,
    );
    const user =
      typeof process.getuid === "function"
        ? [`--user`, `${process.getuid()}:${process.getgid()}`]
        : [];
    return [
      "docker",
      [
        "run",
        "--rm",
        "--name",
        celldContainer,
        ...user, // files celld writes in .celld/ belong to the host user, not root
        "-e",
        "HOME=/tmp",
        "--network",
        "host",
        "-e",
        `CELLD_ESBUILD=${esbuildBin}`,
        "-v",
        `${repo}:${repo}`,
        "-w",
        dir,
        process.env.CELLD_IMAGE ?? "ghcr.io/denoland/celld:0.6.0",
        ...args,
      ],
    ];
  },
};
const celldContainer = `flue-capfs-celld-${port}`;
// celld keeps its state in <project>/.celld/dev, shared by every run in this project (do not run
// two celld runs at once): the first start passes --clean, the restart reuses the state.
let celldClean = env === "celld";
// celld cannot pass RpcTargets between isolates yet: the token transport only.
if (env === "celld") process.env.TRANSPORTS ??= "token";
if (!commands[env]) {
  console.error(`usage: run-env.mjs ${Object.keys(commands).join(" | ")}`);
  process.exit(2);
}
const [cmd, args] = typeof commands[env] === "function" ? await commands[env]() : commands[env];
process.on("exit", () => {
  if (ownDevVars) rmSync(join(dir, ".dev.vars"), { force: true });
});
const cleanup = () => {
  if (env === "celld" && cmd === "docker")
    spawnSync("docker", ["rm", "-f", celldContainer], { stdio: "ignore" });
};
const base = `http://127.0.0.1:${port}`;

async function startRuntime() {
  cleanup(); // a leftover container of the same name would answer the readiness check
  const child = spawn(cmd, celldClean ? [...args, "--clean"] : args, {
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
  try {
    await Promise.race([ready, failed]);
  } catch (e) {
    await stopRuntime(child).catch(() => {});
    throw e;
  }
  failed.catch(() => {}); // a late 'error' event must not become an unhandled rejection
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
  cleanup();
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
let stopping;
const shutdown = async (code) => {
  stopping ??= child
    ? stopRuntime(child).catch((e) => console.error(e.message))
    : Promise.resolve();
  await stopping;
  process.exit(code);
};
process.on("SIGINT", () => shutdown(130));
process.on("SIGTERM", () => shutdown(143));

try {
  child = await startRuntime();
} catch (e) {
  console.error(`${env}: ${e.message}`);
  await shutdown(3);
}
celldClean = false;
console.log(
  `${env}: ready on ${base} (state: ${env === "celld" ? join(dir, ".celld/dev") : state})`,
);
const durability = { DURABILITY_FILE: join(state, "durability.json") };
// A test run killed by a signal exits with code null: count it as a failure.
const failed = (code) => code !== 0;
let code = await runTests("tests/scenario.test.mjs");
if (!failed(code)) code = await runTests("tests/python.test.mjs");
if (!failed(code)) code = await runTests("tests/agent.test.mjs");
if (!failed(code)) code = await runTests("tests/wasmer.test.mjs");
if (!failed(code))
  code = await runTests("tests/durability.test.mjs", { ...durability, PHASE: "write" });
await stopRuntime(child);
child = undefined;
if (!failed(code)) {
  console.log(`${env}: restarted on the same state`);
  try {
    child = await startRuntime();
  } catch (e) {
    console.error(`${env}: ${e.message}`);
    await shutdown(3);
  }
  code = await runTests("tests/durability.test.mjs", { ...durability, PHASE: "check" });
  await stopRuntime(child);
}
process.exit(failed(code) ? (code ?? 1) : 0);
