import {
  createNotificationModel,
  NotificationsController,
  type NotificationView,
  notificationKind,
  notify,
  notifyUser,
} from "@notifications";
import { notificationsSlot } from "@sys/extension-points";
import { describe, expect, it, vi } from "vitest";
import { newTestContext, settle, tick } from "../support/context.js";

const shown = (slots: ReturnType<typeof newTestContext>["slots"]) =>
  slots.getSnapshot(notificationsSlot).map((c) => (c.model as NotificationView).getMessage().text);

describe("B2 · notifications", () => {
  it("the model carries a frozen message; dismiss flips its control state once", () => {
    const model = createNotificationModel({ text: "Saved", level: "info" });
    const listener = vi.fn();
    model.control.onDismissedUpdate(listener);
    expect(model.view.getMessage()).toEqual({ text: "Saved", level: "info" });
    expect(Object.isFrozen(model.view.getMessage())).toBe(true);
    model.view.dismiss();
    model.view.dismiss();
    expect(model.control.isDismissed()).toBe(true);
    expect(listener).toHaveBeenCalledTimes(2);
    model.dispose();
  });

  it("after dispose, dismiss is a no-op", () => {
    const model = createNotificationModel({ text: "x", level: "info" });
    model.dispose();
    model.view.dismiss();
    expect(model.control.isDismissed()).toBe(false);
  });

  it("notify contributes a toast and resolves shown", async () => {
    const { ctx, commands, slots, recorder } = newTestContext();
    const controller = new NotificationsController({ timeoutMs: 10_000 });
    controller.activate(ctx);
    await expect(commands.call(notify, { text: "Saved", level: "info" }).promise).resolves.toEqual({
      shown: true,
    });
    const [contribution] = slots.getSnapshot(notificationsSlot);
    expect(contribution.kind).toBe(notificationKind);
    expect(shown(slots)).toEqual(["Saved"]);
    expect(recorder.calls).toContainEqual({
      level: "info",
      args: ["notification:shown", { level: "info", text: "Saved" }],
      metadata: { module: "notifications" },
    });
    await controller.dispose();
  });

  it("dismiss withdraws the toast", async () => {
    const { ctx, commands, slots } = newTestContext();
    const controller = new NotificationsController({ timeoutMs: 10_000 });
    controller.activate(ctx);
    await commands.call(notify, { text: "one", level: "info" }).promise;
    await commands.call(notify, { text: "two", level: "error" }).promise;
    const first = slots.getSnapshot(notificationsSlot)[0].model as NotificationView;
    first.dismiss();
    await settle();
    expect(shown(slots)).toEqual(["two"]);
    await controller.dispose();
  });

  it("a toast expires after the timeout", async () => {
    const { ctx, commands, slots } = newTestContext();
    const controller = new NotificationsController({ timeoutMs: 20 });
    controller.activate(ctx);
    await commands.call(notify, { text: "brief", level: "info" }).promise;
    expect(shown(slots)).toEqual(["brief"]);
    await tick(40);
    await settle();
    expect(shown(slots)).toEqual([]);
    await controller.dispose();
  });

  it("dispose withdraws every toast, and notify then has no handler", async () => {
    const { ctx, commands, slots } = newTestContext();
    const controller = new NotificationsController({ timeoutMs: 10_000 });
    controller.activate(ctx);
    await commands.call(notify, { text: "left open", level: "info" }).promise;
    await controller.dispose();
    expect(shown(slots)).toEqual([]);
    await expect(
      commands.call(notify, { text: "late", level: "info" }).promise,
    ).rejects.toMatchObject({
      kind: "no-handlers",
    });
  });

  it("notifyUser never throws: a missing handler becomes a warning", async () => {
    const { commands, recorder } = newTestContext();
    expect(() =>
      notifyUser(commands, recorder.logger, { text: "lost", level: "error" }),
    ).not.toThrow();
    await settle();
    expect(recorder.calls).toContainEqual({
      level: "warn",
      args: ["notify failed: no-handlers: notifications:notify", { text: "lost" }],
      metadata: {},
    });
  });
});
