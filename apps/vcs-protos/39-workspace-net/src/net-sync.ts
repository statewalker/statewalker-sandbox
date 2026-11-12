import type { Endpoint } from "../../38-workspace-sync/src/workspace.js";
export interface Peer {
  name: string;
  url: string;
  fetch: typeof fetch;
}
export function serveEndpoint(_ep: Endpoint): (req: Request) => Promise<Response> {
  throw new Error("not implemented");
}
export async function syncWith(
  _ep: Endpoint,
  _peer: Peer,
  _o: { beforePush?: () => Promise<void> } = {},
): Promise<{ head: string; conflicts: string[]; attempts: number }> {
  throw new Error("not implemented");
}
export async function idle(_ep: Endpoint): Promise<void> {}
export function watchEndpoint(
  _ep: Endpoint,
  _peers: Peer[],
  _o: { pollMs?: number; debounceMs?: number; syncEveryMs?: number; onSync?: () => void } = {},
): { stop(): Promise<void>; idle(): Promise<void> } {
  throw new Error("not implemented");
}
