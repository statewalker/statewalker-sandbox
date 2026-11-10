/** A smart-HTTP (protocol v2) fetch client (X8a) — red stub. */
import type { FilesApi } from "@statewalker/webrun-files";
import type { Repository } from "../../17-repository/src/object-store.js";
export interface FetchStats {
  haves: number;
  rounds: number;
  objects: number;
}
export interface ShallowStore {
  read(): Promise<string[]>;
  write(oids: string[]): Promise<void>;
}
export interface FetchOptions {
  refspecs?: string[];
  depth?: number;
  shallow?: ShallowStore;
  stats?: FetchStats;
  signal?: AbortSignal;
}
export function filesShallow(_files: FilesApi, _path: string): ShallowStore {
  throw new Error("not implemented");
}
export async function fetchFrom(_url: string, _repo: Repository, _opts: FetchOptions = {}) {
  throw new Error("not implemented");
}
export async function clone(_url: string, _repo: Repository, _opts: FetchOptions = {}) {
  throw new Error("not implemented");
}
