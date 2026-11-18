/** Ids come from clients (REST paths, MCP arguments); only UUID-shaped names may touch the file system. */
export function isSafeId(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id);
}
