/**
 * Gitea as a test oracle: the pinned release, checked against its published SHA-256, run headless
 * (SQLite, LFS on) as an unprivileged user — `nobody` when the tests run as root, which Gitea
 * refuses to be.
 */
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  chownSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
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

/** The binary: cached under the temp directory (or GITEA_BIN), verified before every use. */
export function giteaBinary(): string {
  if (process.platform !== "linux" || process.arch !== "x64")
    throw new Error(`the Gitea oracle runs on linux-x64, not ${process.platform}-${process.arch}`);
  const dir = join(tmpdir(), `gitea-${GITEA_VERSION}`);
  const bin = join(dir, "gitea");
  if (!(existsSync(bin) && fileSha(bin) === SHA256)) {
    mkdirSync(dir, { recursive: true, mode: 0o755 });
    const tmp = `${bin}.download`;
    if (process.env.GITEA_BIN) copyFileSync(process.env.GITEA_BIN, tmp);
    else execFileSync("curl", ["-sSfL", "--retry", "3", "-o", tmp, DOWNLOAD], { timeout: 600_000 });
    const got = fileSha(tmp);
    if (got !== SHA256) {
      rmSync(tmp, { force: true });
      throw new Error(`gitea ${GITEA_VERSION}: SHA-256 ${got}, expected ${SHA256}`);
    }
    chmodSync(tmp, 0o755);
    execFileSync("mv", [tmp, bin]);
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
  /** a new empty repository: its clone URL (…/<user>/<name>.git) */
  createRepo(name: string): Promise<string>;
  /** the clone URL with credentials in it (for native git) */
  withCredentials(url: string): string;
  stop(): Promise<void>;
}

export async function startGitea(): Promise<Gitea> {
  const bin = giteaBinary();
  const port = await freePort();
  const work = mkdtempSync(join(tmpdir(), "gitea-work-"));
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
  const proc: ChildProcess = spawn(cmd, argv, { cwd: work, env, stdio: "ignore" });
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      if ((await fetch(`${base}/api/v1/version`)).ok) break;
    } catch {}
    if (Date.now() > deadline || proc.exitCode !== null) {
      proc.kill();
      throw new Error("gitea did not start");
    }
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
    async createRepo(name) {
      const r = await authed(`${base}/api/v1/user/repos`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (r.status !== 201)
        throw new Error(`gitea: creating ${name}: HTTP ${r.status} ${await r.text()}`);
      return `${base}/${user}/${name}.git`;
    },
    withCredentials: (url) => url.replace("http://", `http://${user}:${password}@`),
    async stop() {
      proc.kill("SIGTERM");
      await new Promise((r) => setTimeout(r, 300));
      if (proc.exitCode === null) proc.kill("SIGKILL");
      rmSync(work, { recursive: true, force: true });
    },
  };
}
