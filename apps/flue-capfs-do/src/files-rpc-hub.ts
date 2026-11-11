// The owner side of the files RPC: the Workspace answers each capability's files-RPC calls with
// a @statewalker/webrun-files-rpc server of its own, serving a GuardedFilesApi for that token.
// One server per token binds every stream to the capability that opened it: a stream id (which
// the caller may choose) means nothing to any other capability's server.
//
// Memory is bounded by counting streams, not tokens (a holder can make new tokens by
// attenuation): at most `maxStreams` open in the Workspace and `maxStreamsPerSession` for all
// tokens of one session together. A read stream holds about five chunks of 1 MiB (the one asked,
// what the window lets a reader ask ahead, one read ahead, one kept behind); a write at most four
// (two windows of two). Servers are kept for `maxServers` tokens; only idle ones (no open stream)
// are closed to make room, so a capability's streams are never cut by another's calls.
//
// A server's streams expire a little before the store's (STREAM_IDLE_MS), so a holder's stream
// that was idle too long is UNKNOWN_STREAM (the holder reopens it), not the store's EBADF.

import { type FilesRpcServer, newFilesRpcServer } from "@statewalker/webrun-files-rpc";
import { type Authority, FsGate } from "./authority.ts";
import { FILES_RPC_METHODS, RPC_CHUNK_BYTES } from "./files-rpc.ts";
import { GuardedFilesApi } from "./guarded-files-api.ts";
import { fsError } from "./path.ts";
import { type SqlFs, STREAM_IDLE_MS } from "./sql-fs.ts";

export interface FilesRpcHubOptions {
  /** Files-RPC servers kept at once (one per capability token in use). Default 64. */
  maxServers?: number;
  /** Open streams in the Workspace (the store allows 256). Default 16. */
  maxStreams?: number;
  /** Open streams of one session, all its tokens together (the store: 32 per token). Default 8. */
  maxStreamsPerSession?: number;
}

const SWEEP_EVERY_MS = 5_000;
const METHODS = new Set<string>(FILES_RPC_METHODS);
const OPENS = new Set(["openRead", "openWrite"]);

interface Entry {
  server: FilesRpcServer;
  session: string;
}

export class FilesRpcHub {
  #store: SqlFs;
  #auth: Authority;
  #maxServers: number;
  #maxStreams: number;
  #maxPerSession: number;
  /** By token, least recently used first. */
  #servers = new Map<string, Entry>();
  #swept = 0;
  constructor(store: SqlFs, auth: Authority, options: FilesRpcHubOptions = {}) {
    this.#store = store;
    this.#auth = auth;
    this.#maxServers = options.maxServers ?? 64;
    this.#maxStreams = options.maxStreams ?? 16;
    this.#maxPerSession = options.maxStreamsPerSession ?? 8;
  }

  /** Answers one files-RPC call of `token`. */
  async call(token: string, method: unknown, args: unknown): Promise<unknown> {
    if (typeof method !== "string" || !METHODS.has(method))
      throw fsError("ENOSYS", `files-RPC method not available '${String(method)}'`);
    if (args !== undefined && !Array.isArray(args))
      throw fsError("EINVAL", "files-RPC arguments must be an array");
    const opening = OPENS.has(method);
    const { server, session } = await this.#entry(token, opening);
    if (opening) this.#roomFor(session);
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
    for (const e of this.#servers.values()) n += e.server.openStreams();
    return n;
  }

  /** Room for one more stream of `session` (EMFILE otherwise). */
  #roomFor(session: string) {
    let all = 0;
    let mine = 0;
    for (const e of this.#servers.values()) {
      const n = e.server.openStreams();
      all += n;
      if (e.session === session) mine += n;
    }
    if (mine >= this.#maxPerSession)
      throw fsError("EMFILE", `too many open streams for this session (${this.#maxPerSession})`);
    if (all >= this.#maxStreams)
      throw fsError("EMFILE", `too many open streams in this workspace (${this.#maxStreams})`);
  }

  async #entry(token: string, opening: boolean): Promise<Entry> {
    this.#sweep();
    const kept = this.#servers.get(token);
    if (kept) {
      this.#servers.delete(token); // most recently used: to the end
      this.#servers.set(token, kept);
      return kept;
    }
    // A live token of this workspace (not forged, not revoked): no server otherwise. Rights are
    // checked on every operation by the gate.
    const { session } = await this.#auth.live(token);
    const again = this.#servers.get(token); // another call may have made it meanwhile
    if (again) return again;
    const entry: Entry = {
      session,
      server: newFilesRpcServer({
        fs: new GuardedFilesApi(new FsGate(this.#store, this.#auth, token)),
        chunkSize: RPC_CHUNK_BYTES,
        maxChunkSize: RPC_CHUNK_BYTES,
        readAhead: 1,
        retain: 1,
        window: 3,
        writeWindow: 2,
        maxStreams: this.#maxPerSession,
        idleTimeout: STREAM_IDLE_MS - 15_000,
      }),
    };
    if (this.#servers.size >= this.#maxServers && !this.#evictIdle()) {
      // Every kept server has open streams. A call that opens none is answered by a server used
      // once (it has no streams to lose); an open is refused.
      if (opening) throw fsError("EMFILE", "too many capabilities are streaming in this workspace");
      return entry;
    }
    this.#servers.set(token, entry);
    return entry;
  }

  /** Closes the least recently used server with no open stream; false if there is none. */
  #evictIdle(): boolean {
    for (const [t, e] of this.#servers)
      if (e.server.openStreams() === 0) {
        this.#servers.delete(t);
        void e.server.close();
        return true;
      }
    return false;
  }

  #sweep() {
    const now = Date.now();
    if (now - this.#swept < SWEEP_EVERY_MS) return;
    this.#swept = now;
    for (const e of this.#servers.values()) e.server.sweep();
  }
}
