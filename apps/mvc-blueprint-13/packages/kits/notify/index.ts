import {
  NOTIFICATION_TIMEOUT_KEY,
  type NotificationState,
  type NotificationView,
  notificationsSlot,
} from "@p5/shell/api";
import type { Context, KernelSlots, Logger } from "@p5/kernel";
import { getConfig } from "@p5/kernel";

/** Reads the notification timeout from `sys:config` (a read: resolve it at the top of an activator). */
export function getNotificationTimeout(context: Context): number {
  const value = getConfig(context)[NOTIFICATION_TIMEOUT_KEY];
  return typeof value === "number" ? value : 4000;
}

/**
 * Publishes a notification owned by the caller, and withdraws it on dismiss or after `timeoutMs`
 * (then `gone` runs). Returns the withdrawal (idempotent, clears the timer).
 */
export function notify(
  slots: KernelSlots,
  timeoutMs: number,
  state: NotificationState,
  gone: () => void = () => {},
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
    gone();
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
  /**
   * A handler's failure path: notifies (tone `error`) and logs. Every failure path of a commit
   * handler ends here — writing the form too while its session is open is the handler's business.
   */
  fail(message: string): void;
  /** Notifications still shown: nothing is kept once one is withdrawn. */
  readonly size: number;
  /** Withdraws every notification still shown and clears their timers. */
  dispose(): void;
}

/** A controller's notifications: each is withdrawn on dismiss, on timeout, or on `dispose()`. */
export function newNotifier(
  slots: KernelSlots,
  timeoutMs: number,
  log: Pick<Logger, "warn">,
): Notifier {
  const live = new Set<() => void>();
  let disposed = false;
  const notifier: Notifier = {
    notify(state) {
      if (disposed) return;
      // Withdrawn by timer, dismiss or dispose: the entry leaves `live` in every case.
      const withdraw: () => void = notify(slots, timeoutMs, state, () => live.delete(withdraw));
      live.add(withdraw);
    },
    fail(message) {
      log.warn("failure notified", { message });
      notifier.notify({ message, tone: "error" });
    },
    dispose() {
      disposed = true;
      for (const withdraw of [...live]) withdraw();
    },
    get size() {
      return live.size;
    },
  };
  return notifier;
}
