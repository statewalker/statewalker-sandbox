import { newRegistry } from "@statewalker/shared-registry";
import type { Slots } from "@statewalker/shared-slots";
import {
  type AppContext,
  getSlots,
  progressSlot,
  type RunningOperation,
  runningOperationsSlot,
} from "@sys";
import { progressBarKind } from "./models.js";
import { createProgressBarModel } from "./progress-bar-model.js";

/**
 * A projection: any operation contributed to `ops:running` gets a bar in
 * `ui:progress`. The policy "a running operation shows progress" lives here,
 * once, and no UI component has to publish anything to make it true.
 */
export class ProgressController {
  private readonly _registry = newRegistry();
  private readonly _bars = new Map<RunningOperation, () => void>();

  activate(ctx: AppContext): void {
    const [register] = this._registry;
    const slots = getSlots(ctx);
    register(() => {
      for (const release of this._bars.values()) release();
      this._bars.clear();
    });
    register(slots.observe(runningOperationsSlot, (operations) => this._sync(slots, operations)));
  }

  async dispose(): Promise<void> {
    const [, cleanup] = this._registry;
    await cleanup();
  }

  private _sync(slots: Slots, operations: readonly RunningOperation[]): void {
    const live = new Set(operations);
    for (const [operation, release] of this._bars) {
      if (live.has(operation)) continue;
      release();
      this._bars.delete(operation);
    }
    for (const operation of operations) {
      if (this._bars.has(operation)) continue;
      const bar = createProgressBarModel(operation);
      const off = slots.provide(progressSlot, { kind: progressBarKind, model: bar.view });
      this._bars.set(operation, () => {
        off();
        bar.dispose();
      });
    }
  }
}
