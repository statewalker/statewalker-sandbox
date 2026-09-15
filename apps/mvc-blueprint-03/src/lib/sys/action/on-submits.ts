import type { ActionControl } from "./action.model.js";

export interface SubmitWatch {
  /** True once per batch of submits since the last take — two clicks in one tick are one intent. */
  take(): boolean;
}

/** A handled watermark over an action's submits. It starts at the current count: earlier submits are not its intents. */
export function watchSubmits(control: ActionControl): SubmitWatch {
  let handled = control.getSubmits();
  return {
    take() {
      const current = control.getSubmits();
      if (current <= handled) return false;
      handled = current;
      return true;
    },
  };
}
