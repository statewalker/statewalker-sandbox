import { WorkbenchSecretMissingError } from "./errors.js";
import type { FilesApiSecretStore } from "./files-api-secret-store.js";

/**
 * Pure boot-gate helper extracted from `createWorkbench`. Returns the
 * resolved secret value, or throws `WorkbenchSecretMissingError` so the
 * caller can refuse to expose a partially-initialised workbench.
 *
 * Order of resolution:
 * 1. If `secrets.get(name)` already returns a non-empty value, use it.
 * 2. Otherwise call `onSecretRequest(name)`. If it resolves with a
 *    non-empty string, persist via `secrets.set(name, value)` and return.
 * 3. Any rejection, or an empty resolution, becomes
 *    `WorkbenchSecretMissingError`. Nothing is persisted in those cases.
 */
export async function gateSecret(
  secrets: FilesApiSecretStore,
  name: string,
  onSecretRequest: (name: string) => Promise<string>,
): Promise<string> {
  const existing = await secrets.get(name);
  if (existing) return existing;

  let provided: string;
  try {
    provided = await onSecretRequest(name);
  } catch (_cause) {
    throw new WorkbenchSecretMissingError(name);
  }
  if (!provided) {
    throw new WorkbenchSecretMissingError(name);
  }
  await secrets.set(name, provided);
  return provided;
}
