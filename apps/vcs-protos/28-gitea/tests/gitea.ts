/**
 * Gitea as a test oracle: the pinned release, checked against its published SHA-256, run headless
 * (SQLite, LFS on) as an unprivileged user — `nobody` when the tests run as root, which Gitea
 * refuses to be.
 */
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  chownSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const GITEA_VERSION = "1.22.6";
const SHA256 = "fd77f1a0273c85a0950207c1cfa6753a9fa57604e4ab1382484b191cc919ce15";
const DOWNLOAD = `https://dl.gitea.com/gitea/${GITEA_VERSION}/gitea-${GITEA_VERSION}-linux-amd64`;

const fileSha = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

/**
 * The binary, cached (GITEA_CACHE_DIR, else under the temp directory) and verified before every
 * use; fetched from GITEA_BIN or the release URL. Each writer downloads to a name of its own and
 * renames it into place (atomic; every writer writes the same bytes), so parallel runs do not race.
 */
export function giteaBinary(): string {
  if (process.platform !== "linux" || process.arch !== "x64")
    throw new Error(`the Gitea oracle runs on linux-x64, not ${process.platform}-${process.arch}`);
  const dir = process.env.GITEA_CACHE_DIR ?? join(tmpdir(), `gitea-${GITEA_VERSION}`);
  const bin = join(dir, "gitea");
  const valid = () => existsSync(bin) && fileSha(bin) === SHA256;
  if (!valid()) {
    mkdirSync(dir, { recursive: true, mode: 0o755 });
    const tmp = `${bin}.${process.pid}.${randomUUID()}`;
    try {
      if (process.env.GITEA_BIN) {
        copyFileSync(process.env.GITEA_BIN, tmp);
        // a copy keeps the source's owner: ours, so no other user can rewrite it before use
        const uid = process.getuid?.();
        const gid = process.getgid?.();
        if (uid !== undefined && gid !== undefined) chownSync(tmp, uid, gid);
      } else
        execFileSync("curl", ["-sSfL", "--retry", "3", "-o", tmp, DOWNLOAD], { timeout: 600_000 });
      const got = fileSha(tmp);
      if (got !== SHA256)
        throw new Error(`gitea ${GITEA_VERSION}: SHA-256 ${got}, expected ${SHA256}`);
      chmodSync(tmp, 0o755);
      renameSync(tmp, bin);
    } catch (e) {
      rmSync(tmp, { force: true });
      if (!valid()) throw e; // another writer may have put it in place meanwhile
    }
  }
  chmodSync(dir, 0o755);
  return bin;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

function chownTree(path: string, uid: number, gid: number) {
  chownSync(path, uid, gid);
  if (statSync(path).isDirectory())
    for (const e of readdirSync(path)) chownTree(join(path, e), uid, gid);
}

export interface Gitea {
  base: string;
  user: string;
  password: string;
  /** Basic credentials for the admin */
  authorization: string;
  /** fetch with the admin's credentials */
  fetch: typeof fetch;
  /** a new empty repository (private unless asked otherwise): its clone URL (…/<user>/<name>.git) */
  createRepo(name: string, opts?: { private?: boolean }): Promise<string>;
  /** the clone URL with credentials in it (for native git) */
  withCredentials(url: string): string;
  stop(): Promise<void>;
}

/** Gitea on a free port; a start that fails (a port taken meanwhile) is retried on another. */
export async function startGitea(): Promise<Gitea> {
  let last: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await startOnce();
    } catch (e) {
      last = e;
    }
  }
  throw last;
}

/** SIGTERM to the whole process group (runuser and Gitea), then SIGKILL if it outlives `ms` */
async function stopGroup(proc: ChildProcess, ms = 10_000) {
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  const exited = new Promise<void>((r) => proc.once("exit", () => r()));
  const kill = (sig: NodeJS.Signals) => {
    try {
      if (proc.pid) process.kill(-proc.pid, sig);
    } catch {}
  };
  kill("SIGTERM");
  const timedOut = await Promise.race([
    exited.then(() => false),
    new Promise<boolean>((r) => setTimeout(() => r(true), ms)),
  ]);
  if (timedOut) {
    kill("SIGKILL");
    await exited;
  }
}

async function startOnce(): Promise<Gitea> {
  const bin = giteaBinary();
  const port = await freePort();
  const work = mkdtempSync(join(tmpdir(), "gitea-work-"));
  let proc: ChildProcess | undefined;
  let log = "";
  try {
    const conf = join(work, "custom", "conf");
    mkdirSync(conf, { recursive: true });
    const asRoot = process.getuid?.() === 0;
    const runUser = asRoot ? "nobody" : execFileSync("id", ["-un"]).toString().trim();
    writeFileSync(
      join(conf, "app.ini"),
      [
        `RUN_USER = ${runUser}`,
        `WORK_PATH = ${work}`,
        "[database]",
        "DB_TYPE = sqlite3",
        `PATH = ${work}/data/gitea.db`,
        "[server]",
        "HTTP_ADDR = 127.0.0.1",
        `HTTP_PORT = ${port}`,
        `ROOT_URL = http://127.0.0.1:${port}/`,
        "LFS_START_SERVER = true",
        "OFFLINE_MODE = true",
        "[lfs]",
        `PATH = ${work}/data/lfs`,
        "[security]",
        "INSTALL_LOCK = true",
        "[service]",
        "DISABLE_REGISTRATION = true",
        "[log]",
        "LEVEL = Warn",
        "[repository]",
        `ROOT = ${work}/repos`,
        "",
      ].join("\n"),
    );
    if (asRoot) {
      const uid = Number(execFileSync("id", ["-u", "nobody"]).toString());
      const gid = Number(execFileSync("id", ["-g", "nobody"]).toString());
      chmodSync(work, 0o755);
      chownTree(work, uid, gid);
    }
    const env = { HOME: work, GITEA_WORK_DIR: work, PATH: process.env.PATH ?? "/usr/bin:/bin" };
    const command = (args: string[]): [string, string[]] =>
      asRoot
        ? [
            "runuser",
            ["-u", "nobody", "--", "env", `HOME=${work}`, `GITEA_WORK_DIR=${work}`, bin, ...args],
          ]
        : [bin, args];
    const run = (args: string[]) => {
      const [cmd, argv] = command(args);
      return execFileSync(cmd, argv, { cwd: work, env, timeout: 120_000 }).toString();
    };
    const ini = join(conf, "app.ini");
    run(["migrate", "-c", ini]);
    const user = "tester";
    const password = "oracle-pass-1";
    run([
      "admin",
      "user",
      "create",
      "--admin",
      "--username",
      user,
      "--password",
      password,
      "--email",
      "tester@example.com",
      "--must-change-password=false",
      "-c",
      ini,
    ]);
    const [cmd, argv] = command(["web", "-c", ini]);
    // its own process group: a stop reaches Gitea itself, not only runuser
    const web = spawn(cmd, argv, {
      cwd: work,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    proc = web;
    const keep = (c: Buffer) => {
      log = (log + c.toString()).slice(-4000);
    };
    web.stdout?.on("data", keep);
    web.stderr?.on("data", keep);
    const base = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 60_000;
    for (;;) {
      try {
        // Gitea's own answer (not another server that took the port)
        const r = await fetch(`${base}/api/v1/version`);
        if (r.ok && (await r.text()).includes(`"version":"${GITEA_VERSION}"`)) break;
      } catch {}
      if (Date.now() > deadline || web.exitCode !== null || web.signalCode !== null)
        throw new Error(`gitea did not start on port ${port}`);
      await new Promise((r) => setTimeout(r, 250));
    }
    const authorization = `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;
    const authed = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, { ...init, duplex: "half" } as RequestInit);
      const headers = new Headers(req.headers);
      if (!headers.has("authorization")) headers.set("authorization", authorization);
      return fetch(new Request(req, { headers, duplex: "half" } as RequestInit));
    }) as typeof fetch;
    return {
      base,
      user,
      password,
      authorization,
      fetch: authed,
      async createRepo(name, o = {}) {
        const r = await authed(`${base}/api/v1/user/repos`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name, private: o.private ?? true }),
        });
        if (r.status !== 201)
          throw new Error(`gitea: creating ${name}: HTTP ${r.status} ${await r.text()}`);
        return `${base}/${user}/${name}.git`;
      },
      withCredentials: (url) => url.replace("http://", `http://${user}:${password}@`),
      async stop() {
        await stopGroup(web);
        rmSync(work, { recursive: true, force: true, maxRetries: 5 });
      },
    };
  } catch (e) {
    if (proc) await stopGroup(proc, 5000);
    rmSync(work, { recursive: true, force: true, maxRetries: 5 });
    const tail = log.trim() ? `\n--- gitea log ---\n${log.trim()}` : "";
    throw new Error(`${(e as Error).message}${tail}`, { cause: e });
  }
}
