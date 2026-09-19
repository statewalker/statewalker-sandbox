import {
  NOTIFICATION_TIMEOUT_KEY,
  type NotificationState,
  type NotificationView,
  notificationsSlot,
} from "@p5/shell/api";
import type { Context, KernelSlots } from "@p5/kernel";
import { getConfig } from "@p5/kernel";

/** Reads the notification timeout from `sys:config` (a read: resolve it at the top of an activator). */
export function getNotificationTimeout(context: Context): number {
  const value = getConfig(context)[NOTIFICATION_TIMEOUT_KEY];
  return typeof value === "number" ? value : 4000;
}

/**
 * Publishes a notification owned by the caller, and withdraws it on dismiss or after `timeoutMs`.
 * Returns the withdrawal (idempotent, clears the timer) — register it with the owner's cleanup.
 */
export function notify(
  slots: KernelSlots,
  timeoutMs: number,
  state: NotificationState,
): () => void {
  const frozen = Object.freeze({ ...state });
  let withdrawn = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let release = () => {};
  const withdraw = () => {
    if (withdrawn) return;
    withdrawn = true;
    if (timer !== undefined) clearTimeout(timer);
    release();
  };
  const model: NotificationView = Object.freeze({
    getState: () => frozen,
    onStateUpdate: (listener: () => void) => {
      try {
        listener();
      } catch (error) {
        console.error(error);
      }
      return () => {};
    },
    dismiss: () => withdraw(),
  });
  release = slots.provide(notificationsSlot, { id: `n-${crypto.randomUUID()}`, model });
  if (timeoutMs > 0 && Number.isFinite(timeoutMs)) timer = setTimeout(withdraw, timeoutMs);
  return withdraw;
}

export interface Notifier {
  notify(state: NotificationState): void;
  /** Withdraws every notification still shown and clears their timers. */
  dispose(): void;
}

/** A controller's notifications: each is withdrawn on dismiss, on timeout, or on `dispose()`. */
export function newNotifier(slots: KernelSlots, timeoutMs: number): Notifier {
  const live = new Set<() => void>();
  let disposed = false;
  return {
    notify(state) {
      if (disposed) return;
      const withdraw = notify(slots, timeoutMs, state);
      const tracked = () => {
        live.delete(tracked);
        withdraw();
      };
      live.add(tracked);
      // Timer or dismiss withdraw through `withdraw` directly; drop the stale entry lazily.
    },
    dispose() {
      disposed = true;
      for (const withdraw of [...live]) withdraw();
      live.clear();
    },
  };
}
