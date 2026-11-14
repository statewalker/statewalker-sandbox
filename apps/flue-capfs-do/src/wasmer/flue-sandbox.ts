// A Flue sandbox on Wasmer: `exec` runs in the run's Wasmer sandbox (real bash, coreutils, grep,
// ripgrep, find), whose /workspace is the capability; the file operations call the same
// capability directly. Flue's tools (read, write, edit, grep, glob, bash) then work as they do on
// just-bash, with the same rights. Paths are guest paths: /workspace/x is the capability's /x.

import { bytesToString, stringToBytes } from "../bytes.ts";
import { capBytes } from "../cap-bytes.ts";
import type { Cap } from "../caps.ts";
import type { WasmerSession } from "./kernel.ts";

export const WORKSPACE = "/workspace";

/** An absolute guest path, with "." and ".." resolved (relative paths are under /workspace). */
export function resolveGuestPath(p: string): string {
  const out: string[] = [];
  for (const s of (p.startsWith("/") ? p : `${WORKSPACE}/${p}`).split("/")) {
    if (!s || s === ".") continue;
    if (s === "..") out.pop();
    else out.push(s);
  }
  return `/${out.join("/")}`;
}

export function flueSandboxOnWasmer(session: WasmerSession, cap: Cap) {
  const bytes = capBytes(cap);
  const capPath = (p: string) => {
    const abs = resolveGuestPath(p);
    if (abs !== WORKSPACE && !abs.startsWith(`${WORKSPACE}/`))
      throw Object.assign(new Error(`ENOENT: '${p}' is outside ${WORKSPACE}`), { code: "ENOENT" });
    return abs.slice(WORKSPACE.length) || "/";
  };
  return {
    cwd: WORKSPACE,
    resolvePath: resolveGuestPath,
    async exec(
      command: string,
      options: { cwd?: string; env?: Record<string, string>; timeoutMs?: number } = {},
    ) {
      const r = await session.exec(command, {
        cwd: options.cwd ?? WORKSPACE,
        env: options.env,
        timeoutMs: options.timeoutMs,
      });
      return { stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode };
    },
    // Bytes only cross the capability (text encoded and decoded here as UTF-8); files larger
    // than a whole-file call move as files-RPC streams.
    readFile: async (p: string) => bytesToString(await bytes.read(capPath(p)), "utf8"),
    readFileBuffer: async (p: string) => bytes.read(capPath(p)),
    writeFile: async (p: string, c: string | Uint8Array) =>
      bytes.write(capPath(p), typeof c === "string" ? stringToBytes(c, "utf8") : c),
    stat: async (p: string) => {
      const s = (await cap.call("stat", capPath(p))) as {
        isDirectory: boolean;
        size: number;
        mtime: string;
      };
      return { ...s, isFile: !s.isDirectory, isSymbolicLink: false, mtime: new Date(s.mtime) };
    },
    readdir: (p: string) => cap.readdir(capPath(p)),
    exists: async (p: string) => {
      try {
        return (await cap.call("exists", capPath(p))) as boolean;
      } catch {
        return false;
      }
    },
    mkdir: async (p: string, o?: { recursive?: boolean }) => {
      await cap.call("mkdir", capPath(p), o);
    },
    rm: async (p: string, o?: { recursive?: boolean; force?: boolean }) => {
      await cap.call("rm", capPath(p), o);
    },
  };
}
