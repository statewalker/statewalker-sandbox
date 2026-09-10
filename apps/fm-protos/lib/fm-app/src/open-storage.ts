import type { Command, Commands } from "@statewalker/shared-commands";

/** See fm-core/file-commands: `claimed` is set by the bus, typed internally. */
type Claimable<P, R> = Command<P, R> & { readonly claimed: boolean };
import type { FilesApi } from "@statewalker/webrun-files";
import type { StorageRegistry } from "@fm/core";
import { storagesOpen } from "@fm/core";

export interface PickedStorage {
  api: FilesApi;
  name: string;
  /** Optional: a handler may propose its own URI scheme. */
  uri?: string;
}

export type Picker = (request: { mode: "read" | "readwrite"; suggestedName?: string }) =>
  Promise<PickedStorage | undefined>;

let seq = 0;

/**
 * Turns a picker into a `storages:open` handler.
 *
 * The picker is injected, which is the whole seam: in production it calls
 * `showDirectoryPicker()` and wraps the handle; in a test it returns an
 * in-memory filesystem. Everything downstream — the registry, the panel, the
 * job engine — is identical either way, so the tests exercise the real path
 * rather than a parallel one.
 *
 * Returning `undefined` means the user dismissed the dialog. That is a normal
 * outcome, not a failure: it resolves `{ cancelled: true }` and nothing is
 * registered.
 */
export function registerStorageOpener(
  commands: Commands,
  registry: StorageRegistry,
  pick: Picker,
): () => void {
  // A FALLBACK, per the C5 rule: negative priority orders listeners, it does
  // not stop them, so this must decline explicitly when a host has claimed the
  // command. Without the guard the app's picker runs alongside the host's and
  // adopts a storage nobody asked for.
  return commands.listen(
    storagesOpen,
    (cmd) => ((cmd as Claimable<typeof cmd.payload, never>).claimed ? undefined : open(cmd)),
    { priority: -1 },
  );

  async function open(cmd: { payload: { mode: "read" | "readwrite"; suggestedName?: string } }) {
    const picked = await pick({
      mode: cmd.payload.mode,
      suggestedName: cmd.payload.suggestedName,
    });
    if (!picked) return { cancelled: true };

    const uri = picked.uri ?? `picked://${++seq}/${encodeURIComponent(picked.name)}`;
    registry.adopt(uri, picked.api, {
      name: picked.name,
      caps: cmd.payload.mode === "read" ? { write: false, move: false, remove: false } : undefined,
    });
    return { cancelled: false, uri, name: picked.name };
  }
}
