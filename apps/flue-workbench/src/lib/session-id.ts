/**
 * Format a stable Flue session id from a host-supplied workspace key.
 *
 * The format is `workbench/<key>/main` — three slash-separated parts. The
 * trailing `main` slot is reserved for future multi-session support
 * (`workbench/<key>/triage`, etc.) without changing the storage path
 * format. Forward slashes inside the key are URL-encoded to keep the id
 * exactly three parts long.
 */
export function workbenchSessionId(workspaceKey: string): string {
  if (!workspaceKey) {
    throw new Error("workbenchSessionId: workspaceKey must be a non-empty string");
  }
  const safe = workspaceKey.replace(/\//g, "%2F");
  return `workbench/${safe}/main`;
}
