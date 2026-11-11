// The holder side of streaming: a FilesApi over a capability, by @statewalker/webrun-files-rpc.
// The capability carries the files-RPC calls (`cap.rpc(method, args)`) to the Workspace, which
// answers them with a files-RPC server for that capability (src/files-rpc-hub.ts). Content moves
// as chunks keyed by (streamId, chunkId), each an ordinary capability call: Durable Object RPC
// carries no ReadableStream on cellb and celld, but it carries bytes.

import {
  type FilesRpc,
  type FilesRpcClient,
  newFilesRpcClient,
} from "@statewalker/webrun-files-rpc";

/** The files-RPC methods a capability carries (and nothing else of the server). */
export const FILES_RPC_METHODS = [
  "stats",
  "exists",
  "mkdir",
  "remove",
  "move",
  "copy",
  "list",
  "openRead",
  "readChunk",
  "closeRead",
  "openWrite",
  "writeChunk",
  "closeWrite",
  "abortWrite",
] as const satisfies readonly (keyof FilesRpc)[];

/** Bytes per chunk, both ways: one store block. */
export const RPC_CHUNK_BYTES = 1024 * 1024;

/** Whatever carries files-RPC calls: a Cap, ToolFiles, the tool entrypoint. */
export interface RpcCarrier {
  rpc(method: string, args: unknown[]): Promise<unknown>;
}

/** The files-RPC methods over a capability. */
export function capFilesRpc(cap: RpcCarrier): FilesRpc {
  const rpc: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  for (const m of FILES_RPC_METHODS) rpc[m] = (...args) => cap.rpc(m, args);
  return rpc as unknown as FilesRpc;
}

/**
 * A FilesApi over a capability: files of any size, read, written and appended to (`append`) as
 * streams of chunks.
 */
export function capFiles(cap: RpcCarrier): FilesRpcClient {
  return newFilesRpcClient({
    rpc: capFilesRpc(cap),
    chunkSize: RPC_CHUNK_BYTES,
    readAhead: 2,
    writeAhead: 2,
  });
}
