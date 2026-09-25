import type { ConflictResolution } from "@fm/core";
import type { Commands } from "@statewalker/shared-commands";
import { ConflictDialogModel, uiShowConflict } from "./ui-declarations.js";

/**
 * D1.5 — the seam where parallel batches meet a single-decision UI.
 *
 * The engine calls `onConflict` per conflicting entry and knows nothing about
 * dialogs; this turns that call into `ui:show-dialog:conflict` and back. The
 * engine already serialises decisions (P5), so only one dialog is ever open —
 * but the resolver must still honour the job's AbortSignal, or cancelling with
 * a dialog open leaves the job waiting on an answer that will never come.
 */
export function createConflictResolver(commands: Commands) {
  return async (
    entry: { path: string; target: string },
    signal: AbortSignal,
  ): Promise<ConflictResolution> => {
    const call = commands.call(uiShowConflict, new ConflictDialogModel(entry.path, entry.target));

    const onAbort = () => {
      // Settling the command removes the view: the dialog closes with the job
      // rather than lingering over a job that no longer exists.
      call.reject(new Error("cancelled while awaiting a conflict decision"));
    };
    signal.addEventListener("abort", onAbort, { once: true });

    try {
      return await call.promise;
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  };
}
