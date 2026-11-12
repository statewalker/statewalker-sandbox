// Whole-file reads, writes and appends over a capability, in bytes only. Text is encoded and
// decoded by the holder (src/bytes.ts); the capability carries bytes, whatever the encoding:
//   - up to MAX_WHOLE_FILE_BYTES: one binary call (readFileBuffer, writeFileBuffer,
//     appendFileBuffer), which also answers ENOENT/EISDIR/EACCES as the store does;
//   - above: a files-RPC stream (capFiles: write, append, read), so the size is no limit.
// Used by CapFs (just-bash, Flue's tools) and by Wasmer's Flue sandbox.

import { ownBytes } from "./bytes.ts";
import { capFiles, type RpcCarrier } from "./files-rpc.ts";
import { bytesArg, MAX_WHOLE_FILE_BYTES } from "./sql-fs.ts";

/** What capBytes needs of a capability: binary calls, and files-RPC for large files. */
export interface ByteCarrier extends RpcCarrier {
  call(method: string, path: string, ...args: unknown[]): Promise<unknown>;
}

const codeOf = (e: unknown) =>
  (e as { code?: string })?.code ?? /^(E[A-Z]+):/.exec(String((e as Error)?.message ?? e))?.[1];

async function collect(chunks: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  let size = 0;
  for await (const c of chunks) {
    parts.push(c);
    size += c.length;
  }
  if (parts.length === 1) return parts[0] as Uint8Array;
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export function capBytes(cap: ByteCarrier) {
  let remote: ReturnType<typeof capFiles> | undefined;
  const files = () => (remote ??= capFiles(cap));
  return {
    /** A file's bytes (ENOENT, EISDIR, EACCES as the store answers them). */
    async read(path: string): Promise<Uint8Array> {
      try {
        return bytesArg(await cap.call("readFileBuffer", path));
      } catch (e) {
        // Larger than one call moves: the same file as a stream (its errors were answered above).
        if (codeOf(e) !== "EFBIG") throw e;
        return collect(files().read(path));
      }
    },
    /** Replaces a file's content with `bytes`. */
    async write(path: string, bytes: Uint8Array): Promise<void> {
      if (bytes.length <= MAX_WHOLE_FILE_BYTES)
        await cap.call("writeFileBuffer", path, ownBytes(bytes));
      else await files().write(path, [bytes]);
    },
    /** Adds `bytes` to the end of a file (created if missing). */
    async append(path: string, bytes: Uint8Array): Promise<void> {
      if (bytes.length <= MAX_WHOLE_FILE_BYTES)
        await cap.call("appendFileBuffer", path, ownBytes(bytes));
      else await files().append(path, [bytes]);
    },
  };
}
