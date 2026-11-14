// just-bash IFileSystem implemented purely by calls on a capability. This is what makes
// `ls`, `cat`, `grep -r`, `find`, redirects, `cp`/`mv` — and Flue's read/write/edit/grep/glob/
// bash tools — run on the filtered file system. There is no other file system underneath.
//
// Content crosses the capability as bytes only: text is encoded and decoded here, in the file's
// encoding (UTF-8 by default), and files larger than a whole-file call move as files-RPC streams
// (src/cap-bytes.ts).

import { asBytes, bytesToString, encodingOf, stringToBytes } from "./bytes.ts";
import { capBytes } from "./cap-bytes.ts";
import type { Cap } from "./caps.ts";
import { fsError, normalise } from "./path.ts";
import type { DirEntryStat } from "./sql-fs.ts";

/** The bytes a write stores: a Uint8Array as is, a string in its encoding (UTF-8 by default). */
function content(d: unknown, o: unknown): Uint8Array {
  return asBytes(d) ?? stringToBytes(String(d ?? ""), encodingOf(o) ?? "utf8");
}

interface PlainStat {
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink: boolean;
  size: number;
  mode: number;
  mtime: string | Date;
}

// `/dev/null` is a sink, not a file: Flue's grep/glob tools redirect stderr to it. It is
// handled here, holder-side, and never reaches the store, so it grants no access to data.
const DEV_NULL = "/dev/null";
const isNull = (p: string) => {
  try {
    return normalise(p) === DEV_NULL;
  } catch {
    return false;
  }
};
const NULL_STAT = {
  isFile: true,
  isDirectory: false,
  isSymbolicLink: false,
  size: 0,
  mode: 0o666,
  mtime: new Date(0),
};

export class CapFs {
  #cap: Cap;
  #bytes: ReturnType<typeof capBytes>;
  constructor(cap: Cap) {
    this.#cap = cap;
    this.#bytes = capBytes(cap);
  }
  /** Decoded here, in the file's encoding (UTF-8: as the store decodes, U+FEFF kept). */
  async readFile(p: string, o?: unknown): Promise<string> {
    if (isNull(p)) return "";
    return bytesToString(await this.readFileBuffer(p), encodingOf(o) ?? "utf8");
  }
  async readFileBuffer(p: string): Promise<Uint8Array> {
    if (isNull(p)) return new Uint8Array();
    return this.#bytes.read(p);
  }
  async writeFile(p: string, d: unknown, o?: unknown): Promise<void> {
    if (isNull(p)) return;
    await this.#bytes.write(p, content(d, o));
  }
  async appendFile(p: string, d: unknown, o?: unknown): Promise<void> {
    if (isNull(p)) return;
    await this.#bytes.append(p, content(d, o));
  }
  async exists(p: string): Promise<boolean> {
    if (isNull(p)) return true;
    try {
      return (await this.#cap.call("exists", p)) as boolean;
    } catch {
      return false;
    }
  }
  async stat(p: string) {
    if (isNull(p)) return { ...NULL_STAT };
    const s = (await this.#cap.call("stat", p)) as PlainStat;
    return { ...s, mtime: new Date(s.mtime) };
  }
  lstat(p: string) {
    return this.stat(p);
  }
  realpath(p: string) {
    return this.#cap.call("realpath", p) as Promise<string>;
  }
  readdir(p: string): Promise<string[]> {
    return this.#cap.readdir(p);
  }
  /** One capability call (readdirStat), not a stat per entry. */
  async readdirWithFileTypes(p: string) {
    const entries = (await this.#cap.call("readdirStat", p)) as DirEntryStat[];
    return entries.map((e) => ({
      name: e.name,
      isFile: !e.isDirectory,
      isDirectory: e.isDirectory,
      isSymbolicLink: false,
    }));
  }
  async mkdir(p: string, o?: { recursive?: boolean }): Promise<void> {
    await this.#cap.call("mkdir", p, o ?? {});
  }
  async rm(p: string, o?: { recursive?: boolean; force?: boolean }): Promise<void> {
    await this.#cap.call("rm", p, o ?? {});
  }
  async chmod(p: string, m: number): Promise<void> {
    await this.#cap.call("chmod", p, m);
  }
  async utimes(p: string, a: unknown, m: unknown): Promise<void> {
    await this.#cap.call(
      "utimes",
      p,
      a instanceof Date ? a.getTime() / 1000 : a,
      m instanceof Date ? m.getTime() / 1000 : m,
    );
  }
  cp(s: string, d: string, o?: unknown) {
    return this.#cap.move("cp", s, d, o);
  }
  mv(s: string, d: string) {
    return this.#cap.move("mv", s, d);
  }
  resolvePath(base: string, p: string): string {
    return normalise(p.startsWith("/") ? p : `${base}/${p}`);
  }
  // Synchronous in the interface, so it cannot go over RPC; no just-bash 3.6 command calls it.
  getAllPaths(): string[] {
    return [];
  }
  async symlink(): Promise<void> {
    throw fsError("EPERM", "symlinks are not allowed");
  }
  async link(): Promise<void> {
    throw fsError("EPERM", "hard links are not allowed");
  }
  async readlink(p: string): Promise<string> {
    throw fsError("EINVAL", `not a symlink '${p}'`);
  }
}

export interface ShellResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  aborted?: boolean;
}

/**
 * just-bash aborts exec() on ANY failed redirect write, so a refused `echo x > f` would
 * throw out of the agent loop. Fail closed: report it as a failed command.
 */
export async function safeExec(
  bash: { exec(s: string, o?: { cwd?: string }): Promise<ShellResult> },
  script: string,
  cwd?: string,
): Promise<ShellResult> {
  try {
    const r = await bash.exec(script, cwd ? { cwd } : undefined);
    return { stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode };
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    return {
      stdout: "",
      stderr: `bash: ${msg}\n`,
      exitCode: /^E[A-Z]+:/.test(msg) ? 1 : 2,
      aborted: true,
    };
  }
}
