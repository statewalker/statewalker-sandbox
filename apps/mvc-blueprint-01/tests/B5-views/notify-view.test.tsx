import { Commands } from "@statewalker/shared-commands";
import { NotifyModel, uiNotify } from "@todo/app/models";
import { NotifyView, registerViews } from "@todo/ui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHost, render, waitFor } from "../support/react.js";

/** B5 · the toast. It settles itself; the timeout is injected so this suite waits milliseconds, not seconds. */

const teardown: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of teardown.splice(0).reverse()) await fn();
});

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe("NotifyView", () => {
  it("shows the model's text as a status message", async () => {
    const view = render(
      <NotifyView
        model={new NotifyModel("Removed 2 todos")}
        settle={() => {}}
        timeoutMs={10_000}
      />,
    );
    teardown.push(view.unmount);
    await waitFor(() => view.host.querySelector('[role="status"]') !== null);
    expect(view.host.querySelector('[role="status"]')?.textContent).toContain("Removed 2 todos");
  });

  it("settles itself once the timeout elapses — and not before", async () => {
    // "Not before" is checked well INSIDE the window, after the toast is on
    // screen and its effect has had turns to run: a bare flush() right after
    // render runs before the effect even commits, and would pass for a toast
    // that settles at once.
    const settle = vi.fn<() => void>();
    const view = render(
      <NotifyView model={new NotifyModel("hi")} settle={settle} timeoutMs={400} />,
    );
    teardown.push(view.unmount);
    await waitFor(() => view.host.querySelector('[role="status"]') !== null);
    await sleep(150);
    expect(settle, "150 ms into a 400 ms toast").not.toHaveBeenCalled();
    await waitFor(() => settle.mock.calls.length > 0);
    expect(settle).toHaveBeenCalledExactlyOnceWith();
  });

  it("an unmount before the timeout cancels it — a closed toast settles nothing", async () => {
    const settle = vi.fn<() => void>();
    const view = render(
      <NotifyView model={new NotifyModel("hi")} settle={settle} timeoutMs={30} />,
    );
    await waitFor(() => view.host.querySelector('[role="status"]') !== null);
    view.unmount();
    await sleep(60);
    expect(settle).not.toHaveBeenCalled();
  });

  it("through the bus: the command resolves on its own, and the settle unmounts the toast", async () => {
    const commands = new Commands();
    const mount = createHost();
    const dispose = registerViews(mount, { notifyTimeoutMs: 30 })(commands);
    teardown.push(() => mount.remove(), dispose);

    const cmd = commands.call(uiNotify, new NotifyModel("Removed 2 todos"));
    await waitFor(() => mount.querySelector('[role="status"]') !== null);
    expect(mount.querySelector('[data-view="ui:notify"]')?.textContent).toContain(
      "Removed 2 todos",
    );

    // Raced, so the injected 30 ms is what is under test: the 4 s default
    // would still resolve inside the test's own timeout, and prove nothing.
    const outcome = await Promise.race([
      cmd.promise.then(() => "settled"),
      sleep(500).then(() => "still open after 500 ms"),
    ]);
    expect(outcome, "registerViews must hand notifyTimeoutMs to the toast").toBe("settled");
    await waitFor(() => mount.children.length === 0);
  });
});
