// Start one runtime serving this Worker project, run the OCR scenario against it, restart it on
// the same state and check what must survive (the cached models), stop it.
//   node scripts/run-env.mjs wrangler | cellb | celld
// Models come from a local server (fixtures/models, see scripts/fetch-fixtures.mjs) that counts
// requests, so the restart check can tell a model read from the cell's SQLite from a download.
// celld: CELLD_BIN, or (default) the ghcr.io/denoland/celld:0.6.0 image in Docker (CELLD_IMAGE),
// started as `celld dev <project> --host 127.0.0.1 --port <port> --no-watch`.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createRequire } from "node:module";
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
const state = mkdtempSync(join(tmpdir(), `tesseract-do-${env}-`));
const outDir = join(dir, "e2e-output");
mkdirSync(outDir, { recursive: true });

if (!existsSync(join(dir, "fixtures/models/eng.traineddata"))) {
  console.error("fixtures missing: run `pnpm fixtures` first");
  process.exit(2);
}

// The model server: fixtures/models over HTTP, counting requests per file.
const hits = {};
const modelServer = createHttpServer((req, res) => {
  const name = decodeURIComponent(new URL(req.url, "http://x").pathname.slice(1));
  if (name === "hits") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(hits));
    return;
  }
  const file = join(dir, "fixtures/models", name);
  if (!/^[\w-]+\.traineddata$/.test(name) || !existsSync(file)) {
    res.writeHead(404);
    res.end();
    return;
  }
  hits[name] = (hits[name] ?? 0) + 1;
  res.writeHead(200, { "content-type": "application/octet-stream" });
  res.end(readFileSync(file));
});
const modelPort = await freePort();
await new Promise((r) => modelServer.listen(modelPort, "127.0.0.1", r));
const MODEL_BASE_URL = `http://127.0.0.1:${modelPort}/`;
const VARS = [`MODEL_BASE_URL=${MODEL_BASE_URL}`];

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
      ...VARS.flatMap((v) => ["--var", v.replace("=", ":")]),
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
      ...VARS.flatMap((v) => ["--var", v]),
    ],
  ],
  // celld reads Worker vars from .dev.vars beside the config; a developer's own file is never
  // overwritten. It bundles with esbuild: the project's Linux esbuild is passed as CELLD_ESBUILD.
  celld: () => {
    const devVars = join(dir, ".dev.vars");
    if (existsSync(devVars) && !readFileSync(devVars, "utf8").startsWith(DEV_VARS_MARK)) {
      console.error(`celld: ${devVars} exists; move it away for the test run`);
      process.exit(2);
    }
    writeFileSync(
      devVars,
      `${DEV_VARS_MARK}\n${VARS.map((v) => `${v.replace("=", "='")}'`).join("\n")}\n`,
    );
    ownDevVars = true;
    const args = ["dev", dir, "--host", "127.0.0.1", "--port", String(port), "--no-watch"];
    if (process.env.CELLD_BIN) return [process.env.CELLD_BIN, args];
    if (process.platform !== "linux") {
      console.error(
        "celld in Docker needs a Linux host here: set CELLD_BIN to a local celld instead",
      );
      process.exit(2);
    }
    const repo = join(dir, "../..");
    const fromApp = createRequire(join(dir, "package.json"));
    const esbuildBin = createRequire(fromApp.resolve("esbuild")).resolve(
      `@esbuild/linux-${process.arch === "x64" ? "x64" : process.arch}/bin/esbuild`,
    );
    const user =
      typeof process.getuid === "function"
        ? ["--user", `${process.getuid()}:${process.getgid()}`]
        : [];
    return [
      "docker",
      [
        "run",
        "--rm",
        "--name",
        celldContainer,
        ...user,
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
const celldContainer = `tesseract-do-celld-${port}`;
// celld keeps its state in <project>/.celld/dev: the first start passes --clean, the restart reuses it.
let celldClean = env === "celld";
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
  cleanup();
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
    const deadline = Date.now() + 180_000;
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
  failed.catch(() => {});
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
    env: {
      ...process.env,
      BASE_URL: base,
      RUNTIME: env,
      MODEL_HITS_URL: `${MODEL_BASE_URL}hits`,
      METRICS_FILE: join(outDir, `${env}.json`),
      ...extraEnv,
    },
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
  modelServer.close();
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
const failed = (code) => code !== 0;
let code = await runTests("e2e/scenario.test.mjs");
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
  code = await runTests("e2e/durability.test.mjs");
  await stopRuntime(child);
  child = undefined;
}
await shutdown(failed(code) ? (code ?? 1) : 0);
