// Whole-file reads, writes and appends over a capability, in bytes only. Text is encoded and
// decoded by the holder (src/bytes.ts); the capability carries bytes, whatever the encoding:
//   - up to MAX_WHOLE_FILE_BYTES: one binary call (readFileBuffer, writeFileBuffer,
//     appendFileBuffer), which also answers ENOENT/EISDIR/EACCES as the store does;
//   - above: a files-RPC stream (capFiles: write, append, read). Writes and appends have no
//     size limit here (the store's is 1 GiB); a read is whole in the holder's memory, so it is
//     refused above MAX_HOLDER_READ_BYTES.
// Used by CapFs (just-bash, Flue's tools) and by Wasmer's Flue sandbox.

import { ownBytes } from "./bytes.ts";
import { capFiles, type RpcCarrier } from "./files-rpc.ts";
import { fsError } from "./path.ts";
import { bytesArg, MAX_WHOLE_FILE_BYTES } from "./sql-fs.ts";

/**
 * The largest file read whole into the holder's memory (twice a whole-file call). The bytes,
 * and the string decoded from them, stay well within an isolate's 128 MB.
 */
export const MAX_HOLDER_READ_BYTES = 32 * 1024 * 1024;
/** A streamed append the store refused because the file changed meanwhile is sent this often. */
const APPEND_ATTEMPTS = 3;

/** What capBytes needs of a capability: binary calls, and files-RPC for large files. */
export interface ByteCarrier extends RpcCarrier {
  call(method: string, path: string, ...args: unknown[]): Promise<unknown>;
}

/**
 * The largest file a tool reads through its capability (largeFileCalls): the reply crosses JS
 * RPC from the host to the tool's isolate, which carries up to 32 MiB a message.
 */
export const MAX_TOOL_READ_BYTES = 30 * 1024 * 1024;

const tooLarge = (path: string, max: number) =>
  fsError("EFBIG", `file too large to read whole here '${path}' (over ${max} bytes)`);
const codeOf = (e: unknown) =>
  (e as { code?: string })?.code ?? /^(E[A-Z]+):/.exec(String((e as Error)?.message ?? e))?.[1];

async function collect(
  chunks: AsyncIterable<Uint8Array>,
  path: string,
  max: number,
): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  let size = 0;
  for await (const c of chunks) {
    parts.push(c);
    size += c.length;
    if (size > max) throw tooLarge(path, max); // grew while being read
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

export interface CapBytesOptions {
  /** The largest file read whole (default MAX_HOLDER_READ_BYTES). */
  maxReadBytes?: number;
  /** Runs each streamed transfer (a file over MAX_WHOLE_FILE_BYTES): to limit how many run. */
  streamed?: <T>(transfer: () => Promise<T>) => Promise<T>;
}

export function capBytes(cap: ByteCarrier, options: CapBytesOptions = {}) {
  const maxRead = options.maxReadBytes ?? MAX_HOLDER_READ_BYTES;
  const streamed = options.streamed ?? ((transfer) => transfer());
  let remote: ReturnType<typeof capFiles> | undefined;
  const files = () => (remote ??= capFiles(cap));
  return {
    /** A file's bytes (ENOENT, EISDIR, EACCES as the store answers them). */
    async read(path: string): Promise<Uint8Array> {
      for (let attempt = 1; ; attempt++) {
        try {
          return bytesArg(await cap.call("readFileBuffer", path));
        } catch (e) {
          if (codeOf(e) !== "EFBIG") throw e;
        }
        // Larger than one call moves: the same file as a stream, if the holder can hold it.
        const { size } = (await cap.call("stat", path)) as { size: number };
        if (size > maxRead) throw tooLarge(path, maxRead);
        const bytes = await streamed(() => collect(files().read(path), path, maxRead));
        // A streamed read of a file that is gone (or is now a directory) yields nothing, where
        // the file was over 16 MiB a moment ago: ask again, for the error or the new content.
        if (bytes.length > 0 || attempt >= 2) return bytes;
      }
    },
    /** Replaces a file's content with `bytes`. */
    async write(path: string, bytes: Uint8Array): Promise<void> {
      if (bytes.length <= MAX_WHOLE_FILE_BYTES)
        await cap.call("writeFileBuffer", path, ownBytes(bytes));
      else await streamed(() => files().write(path, [bytes]));
    },
    /** Adds `bytes` to the end of a file (created if missing). */
    async append(path: string, bytes: Uint8Array): Promise<void> {
      if (bytes.length <= MAX_WHOLE_FILE_BYTES)
        return void (await cap.call("appendFileBuffer", path, ownBytes(bytes)));
      // A streamed append commits only if the file did not change meanwhile (ESTALE, refused
      // before anything is applied); the bytes are still here, so send them again.
      return streamed(async () => {
        for (let attempt = 1; ; attempt++) {
          try {
            return await files().append(path, [bytes]);
          } catch (e) {
            if (codeOf(e) !== "ESTALE" || attempt >= APPEND_ATTEMPTS) throw e;
          }
        }
      });
    },
  };
}

/**
 * One streamed tool transfer at a time in this isolate, the others wait their turn: each holds
 * up to about three copies of a file (the chunks, the joined bytes, the RPC message), so a few
 * at once would not fit an isolate's 128 MB.
 */
let toolTransfers: Promise<unknown> = Promise.resolve();
function oneToolTransfer<T>(transfer: () => Promise<T>): Promise<T> {
  const run = toolTransfers.then(transfer, transfer);
  toolTransfers = run.catch(() => {});
  return run;
}

/**
 * `cap.call` for a holder that forwards whole-file calls it did not make itself (a tool's
 * capability: ToolFiles, ToolFilesEntrypoint). readFileBuffer, writeFileBuffer and
 * appendFileBuffer go through capBytes, so a file over MAX_WHOLE_FILE_BYTES is streamed here
 * instead of refused with EFBIG (one such transfer at a time in the isolate; reads up to
 * MAX_TOOL_READ_BYTES, which the reply to the tool can carry); every other call is passed on
 * as it is.
 */
export function largeFileCalls(cap: ByteCarrier) {
  let bytes: ReturnType<typeof capBytes> | undefined;
  const b = () =>
    (bytes ??= capBytes(cap, { maxReadBytes: MAX_TOOL_READ_BYTES, streamed: oneToolTransfer }));
  return (method: string, path: string, ...args: unknown[]): Promise<unknown> => {
    if (typeof path !== "string") return cap.call(method, path, ...args); // refused there
    switch (method) {
      case "readFileBuffer":
        return b().read(path);
      case "writeFileBuffer":
        return b().write(path, bytesArg(args[0]));
      case "appendFileBuffer":
        return b().append(path, bytesArg(args[0]));
      default:
        return cap.call(method, path, ...args);
    }
  };
}

/**
 * `cap` with `before` awaited ahead of every call and files-RPC call: a streamed transfer makes
 * many, so a check (the tool's run still active) holds for each block, not only for the first.
 */
export function everyCall<C extends ByteCarrier>(cap: C, before: () => Promise<void>): ByteCarrier {
  return {
    call: async (method, path, ...args) => {
      await before();
      return cap.call(method, path, ...args);
    },
    rpc: async (method, args) => {
      await before();
      return cap.rpc(method, args);
    },
  };
}
