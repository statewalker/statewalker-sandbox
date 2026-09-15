import { newRegistry } from "@statewalker/shared-registry";
import { newChannels, stableGroup } from "@sys/model-kit";
import { batch, signal, untracked } from "@sys/signals";
import type { ActionControl, ActionModel, ActionState, ActionView } from "./action.model.js";

export interface ActionOptions {
  readonly label: string;
  readonly icon?: string;
  readonly hint?: string;
  /** The base flag. Default `true`. */
  readonly enabled?: boolean;
  /**
   * A reactive guard over the owning model's data, read through signals. The
   * published `enabled` is `enabled && when()`, so a gesture that changes the
   * data and submits in the same tick finds the action already enabled.
   */
  readonly when?: () => boolean;
}

export function createAction(options: ActionOptions): ActionModel {
  const [register, cleanup] = newRegistry();
  let disposed = false;
  const channels = newChannels(() => disposed);
  register(() => channels.dispose());

  const label = signal(options.label);
  const icon = signal<string | undefined>(options.icon);
  const hint = signal<string | undefined>(options.hint);
  const enabled = signal(options.enabled ?? true);
  const running = signal(false);
  const submits = signal(0);
  const when = options.when ?? (() => true);

  // Every input is read before the result is built: a computed depends only on what its last run read.
  const state = stableGroup((): ActionState => {
    const l = label();
    const i = icon();
    const h = hint();
    const e = enabled();
    const r = running();
    const w = when();
    return Object.freeze({ label: l, icon: i, hint: h, enabled: e && w, running: r });
  });

  const view: ActionView = Object.freeze({
    getState: () => state(),
    onStateUpdate: channels.channel(state),
    submit: () => {
      if (disposed) return;
      const current = untracked(() => state());
      if (!current.enabled || current.running) return;
      submits(untracked(() => submits()) + 1);
    },
  });

  const control: ActionControl = Object.freeze({
    getSubmits: () => submits(),
    onSubmitsUpdate: channels.channel(submits),
    update: (patch: Partial<ActionState>) => {
      if (disposed) return;
      batch(() => {
        if (patch.label !== undefined) label(patch.label);
        if (patch.icon !== undefined) icon(patch.icon);
        if (patch.hint !== undefined) hint(patch.hint);
        if (patch.enabled !== undefined) enabled(patch.enabled);
        if (patch.running !== undefined) running(patch.running);
      });
    },
  });

  return Object.freeze({
    view,
    control,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      void cleanup();
    },
  });
}
