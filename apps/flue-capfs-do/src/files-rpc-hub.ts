// The owner side of the files RPC: the Workspace answers each capability's files-RPC calls with
// a @statewalker/webrun-files-rpc server of its own, serving a GuardedFilesApi for that token.
// One server per token binds every stream to the capability that opened it: a stream id (which
// the caller may choose) means nothing to any other capability's server.
//
// Memory: a read stream holds the chunk being read, `readAhead` chunks ahead and `retain` behind
// (1 MiB each); a write holds at most `writeWindow` chunks not yet written. Streams per token and
// servers per Workspace are bounded; idle streams are dropped after STREAM_IDLE_MS (looked for at
// most every few seconds, on any files-RPC call).

import { type FilesRpcServer, newFilesRpcServer } from "@statewalker/webrun-files-rpc";
import { type Authority, FsGate } from "./authority.ts";
import { FILES_RPC_METHODS, RPC_CHUNK_BYTES } from "./files-rpc.ts";
import { GuardedFilesApi } from "./guarded-files-api.ts";
import { fsError } from "./path.ts";
import { type SqlFs, STREAM_IDLE_MS } from "./sql-fs.ts";

/** Files-RPC servers kept at once (one per capability token in use). */
const MAX_SERVERS = 64;
/** Open streams per capability (the store allows 32 per owner, 256 in all). */
const MAX_STREAMS_PER_TOKEN = 16;
const SWEEP_EVERY_MS = 5_000;
const METHODS = new Set<string>(FILES_RPC_METHODS);

export class FilesRpcHub {
  #store: SqlFs;
  #auth: Authority;
  /** By token, least recently used first. */
  #servers = new Map<string, FilesRpcServer>();
  #swept = 0;
  constructor(store: SqlFs, auth: Authority) {
    this.#store = store;
    this.#auth = auth;
  }

  /** Answers one files-RPC call of `token`. */
  async call(token: string, method: unknown, args: unknown): Promise<unknown> {
    if (typeof method !== "string" || !METHODS.has(method))
      throw fsError("ENOSYS", `files-RPC method not available '${String(method)}'`);
    if (args !== undefined && !Array.isArray(args))
      throw fsError("EINVAL", "files-RPC arguments must be an array");
    const server = await this.#server(token);
    // biome-ignore lint/suspicious/noExplicitAny: dispatch over the files-RPC methods checked above
    return (server as any)[method](...((args as unknown[]) ?? []));
  }

  /** Servers kept now (one per capability token in use). */
  get servers(): number {
    return this.#servers.size;
  }

  /** Streams open now, over all capabilities (tests, stats). */
  openStreams(): number {
    let n = 0;
    for (const s of this.#servers.values()) n += s.openStreams();
    return n;
  }

  async #server(token: string): Promise<FilesRpcServer> {
    this.#sweep();
    let server = this.#servers.get(token);
    if (server) {
      this.#servers.delete(token); // most recently used: to the end
      this.#servers.set(token, server);
      return server;
    }
    // A token of this workspace (cached verification): no server for a forged one. Rights are
    // checked on every operation by the gate.
    await this.#auth.sessionOf(token);
    server = this.#servers.get(token); // another call may have made it meanwhile
    if (server) return server;
    server = newFilesRpcServer({
      fs: new GuardedFilesApi(new FsGate(this.#store, this.#auth, token)),
      chunkSize: RPC_CHUNK_BYTES,
      maxChunkSize: RPC_CHUNK_BYTES,
      readAhead: 2,
      retain: 2,
      window: 8,
      writeWindow: 4,
      maxStreams: MAX_STREAMS_PER_TOKEN,
      idleTimeout: STREAM_IDLE_MS,
    });
    this.#servers.set(token, server);
    if (this.#servers.size > MAX_SERVERS) this.#evict();
    return server;
  }

  /** Makes room: the least recently used server with no open stream, else the least recent. */
  #evict() {
    let victim: string | undefined;
    for (const [t, s] of this.#servers)
      if (s.openStreams() === 0) {
        victim = t;
        break;
      }
    victim ??= this.#servers.keys().next().value as string;
    const s = this.#servers.get(victim);
    this.#servers.delete(victim);
    void s?.close();
  }

  #sweep() {
    const now = Date.now();
    if (now - this.#swept < SWEEP_EVERY_MS) return;
    this.#swept = now;
    for (const s of this.#servers.values()) s.sweep();
  }
}
