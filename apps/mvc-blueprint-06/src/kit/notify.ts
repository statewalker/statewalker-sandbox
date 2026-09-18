/**
 * Kit (optional): publish a notification to `shell:notifications` and withdraw it on dismiss or
 * after a timeout. Create one per actor in its setup; route its messages with `handle`.
 */

import { type Notification, notifications } from "../bundles/shell/api/index.js";
import { type ActorContext, type Contributed, contribute } from "../kernel/index.js";

export type NotifierMsg = { readonly type: "sys:dismiss"; readonly id: string };

export interface Notifier {
  notify(message: string, tone: Notification["tone"]): void;
  handle(msg: unknown): boolean;
}

export function newNotifier<M>(ctx: ActorContext<M>, timeoutMs = 4000): Notifier {
  const open = new Map<string, { note: Contributed<Notification>; cancel: () => void }>();
  let seq = 0;
  const dismiss = (id: string) => {
    const entry = open.get(id);
    if (!entry) return;
    open.delete(id);
    entry.cancel();
    entry.note.withdraw();
  };
  return {
    notify(message, tone) {
      const id = `${ctx.self}:note:${++seq}`;
      const note = contribute(ctx, notifications, id, {
        message,
        tone,
        dismiss: {
          id: `${id}:dismiss`,
          label: "Dismiss",
          enabled: true,
          to: ctx.self,
          msg: { type: "sys:dismiss", id } satisfies NotifierMsg,
        },
      });
      open.set(id, { note, cancel: ctx.after(timeoutMs, () => dismiss(id)) });
    },
    handle(msg) {
      if ((msg as NotifierMsg)?.type !== "sys:dismiss") return false;
      dismiss((msg as NotifierMsg).id);
      return true;
    },
  };
}
