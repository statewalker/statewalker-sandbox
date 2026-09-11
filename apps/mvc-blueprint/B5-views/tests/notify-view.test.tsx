import { Commands } from "@statewalker/shared-commands";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NotifyModel, uiNotify } from "@todo/app/models";
import { NotifyView, registerViews } from "@todo/ui";
import { createHost, flush, render, waitFor } from "../../test-support/react.js";

/** B5 · the toast. It settles itself; the timeout is injected so this suite waits milliseconds, not seconds. */

const teardown: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of teardown.splice(0).reverse()) await fn();
});

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe("NotifyView", () => {
  it("shows the model's text as a status message", async () => {
    const view = render(<NotifyView model={new NotifyModel("Removed 2 todos")} settle={() => {}} timeoutMs={10_000} />);
    teardown.push(view.unmount);
    await waitFor(() => view.host.querySelector('[role="status"]') !== null);
    expect(view.host.querySelector('[role="status"]')?.textContent).toContain("Removed 2 todos");
  });

  it("settles itself once the timeout elapses — and not before", async () => {
    const settle = vi.fn<() => void>();
    const view = render(<NotifyView model={new NotifyModel("hi")} settle={settle} timeoutMs={40} />);
    teardown.push(view.unmount);
    await flush();
    expect(settle).not.toHaveBeenCalled();
    await waitFor(() => settle.mock.calls.length > 0);
    expect(settle).toHaveBeenCalledExactlyOnceWith();
  });

  it("an unmount before the timeout cancels it — a closed toast settles nothing", async () => {
    const settle = vi.fn<() => void>();
    const view = render(<NotifyView model={new NotifyModel("hi")} settle={settle} timeoutMs={30} />);
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
    expect(mount.querySelector('[data-view="ui:notify"]')?.textContent).toContain("Removed 2 todos");

    await expect(cmd.promise).resolves.toBeUndefined();
    await waitFor(() => mount.children.length === 0);
  });
});
