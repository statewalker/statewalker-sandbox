/** X17 — workspace sync on history (stubs) */
import type { FilesApi } from "@statewalker/webrun-files";
import type { Repository } from "../../17-repository/src/object-store.js";

export interface Endpoint {
  name: string;
  folder: FilesApi;
  storage: FilesApi;
  repo: Repository;
  now: () => number;
}
const todo = (): never => {
  throw new Error("not implemented");
};
export async function openEndpoint(_o: {
  name: string;
  folder: FilesApi;
  storage: FilesApi;
  now: () => number;
}): Promise<Endpoint> {
  return todo();
}
export async function headOf(_e: Endpoint): Promise<string | undefined> {
  return todo();
}
export async function folderFiles(_e: Endpoint): Promise<Record<string, string>> {
  return todo();
}
export async function sync(
  _a: Endpoint,
  _b: Endpoint,
  _o: { oneWay?: boolean } = {},
): Promise<{ head: string; conflicts: string[] }> {
  return todo();
}
