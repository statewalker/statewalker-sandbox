import type { ActionControl, ActionState, ActionView } from "@p5/kernel";
import { batch, signal, untracked } from "@p5/kit-signals";
import { newChannels, stableGroup } from "./channels.js";

export interface ActionOptions {
  readonly label: string;
  readonly icon?: string;
  readonly hint?: string;
  /** The base flag. Default `true`. */
  readonly enabled?: boolean;
  /**
   * A reactive guard over the owning model's signals. The published `enabled` is
   * `enabled && when()`, derived synchronously: a gesture that edits and submits in one tick
   * finds the action already enabled.
   */
  readonly when?: () => boolean;
  /**
   * Queue (event edge): a submit while `running` is accepted and counted, and the controller
   * honours it after the current run. Default: refuse — a submit while running is ignored and the
   * action shows `running: true`.
   */
  readonly queue?: boolean;
}

export interface ActionModel {
  readonly view: ActionView;
  readonly control: ActionControl;
  dispose(): void;
}

export function createAction(options: ActionOptions): ActionModel {
  let disposed = false;
  const channels = newChannels(() => disposed);
  const label = signal(options.label);
  const icon = signal<string | undefined>(options.icon);
  const hint = signal<string | undefined>(options.hint);
  const enabled = signal(options.enabled ?? true);
  const running = signal(false);
  const submits = signal(0);
  const when = options.when ?? (() => true);

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
      if (!current.enabled || (current.running && !options.queue)) return;
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
      channels.dispose();
    },
  });
}

/**
 * Calls `listener(n)` for every batch of `n` newly accepted submits — synchronously, inside the
 * submit (contract point 4), so it can capture what the commit means at commit time. Skips the
 * channel's immediate call. The listener may read models but must not write them.
 */
export function onSubmits(control: ActionControl, listener: (n: number) => void): () => void {
  let seen = control.getSubmits();
  return control.onSubmitsUpdate(() => {
    const current = control.getSubmits();
    const n = current - seen;
    seen = current;
    if (n > 0) listener(n);
  });
}
