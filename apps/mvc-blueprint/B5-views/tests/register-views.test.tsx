import { CommandError, Commands } from "@statewalker/shared-commands";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BootstrapOptions } from "@todo/app";
import { ConfirmModel, MenuModel, TodoListModel, uiConfirm, uiShowList, uiShowMenu } from "@todo/app/models";
import { registerViews } from "@todo/ui";
import { createHost, waitFor } from "../../test-support/react.js";

/**
 * B5 · the view layer, as bootstrap sees it: `registerViews(mount)` is the
 * `registerViews` option, and the cleanup it hands back joins bootstrap's
 * registry. Each view gets its own container under `mount`, identified by its
 * command key and nothing else (spec §4.1).
 */

let commands: Commands;
let mount: HTMLElement;
let dispose: () => Promise<void>;
let rejections: unknown[];
const onRejection = (event: PromiseRejectionEvent) => {
  rejections.push(event.reason);
};

beforeEach(() => {
  commands = new Commands();
  mount = createHost();
  // Shaped for bootstrap — checked by the compiler, not by a comment.
  const install = registerViews(mount) satisfies BootstrapOptions["registerViews"];
  dispose = install(commands);
  rejections = [];
  window.addEventListener("unhandledrejection", onRejection);
});

afterEach(async () => {
  await dispose();
  mount.remove();
  window.removeEventListener("unhandledrejection", onRejection);
});

const containers = () => [...mount.children].map((c) => (c as HTMLElement).dataset.view);

describe("registerViews", () => {
  it("a ui:show-list command renders a list panel into its own container under mount", async () => {
    const model = new TodoListModel();
    model.replaceTodos([{ id: "1", title: "buy milk", done: false }]);

    const cmd = commands.call(uiShowList, model);
    await waitFor(() => mount.querySelector("li") !== null);

    expect(containers()).toEqual(["ui:show-list"]);
    expect(mount.querySelector('[data-view="ui:show-list"] li')?.textContent).toContain("buy milk");
    expect(cmd.settled).toBe(false); // claimed and long-lived — the controller closes it
  });

  it("settling the command — from the controller's side — removes the panel", async () => {
    const cmd = commands.call(uiShowList, new TodoListModel());
    await waitFor(() => mount.querySelector("ul") !== null);

    cmd.resolve({ closed: true });

    await expect(cmd.promise).resolves.toEqual({ closed: true });
    await waitFor(() => mount.children.length === 0);
  });

  it("two commands are two views — each settles, and unmounts, alone", async () => {
    const a = commands.call(uiShowList, new TodoListModel());
    const b = commands.call(uiShowList, new TodoListModel());
    await waitFor(() => mount.querySelectorAll("ul").length === 2);

    a.resolve({ closed: true });
    await waitFor(() => mount.children.length === 1);
    expect(b.settled).toBe(false);
    expect(mount.querySelector("ul")).not.toBeNull();
  });

  it("dispose removes every open view and rejects exactly the commands still open — nothing else", async () => {
    const done = commands.call(uiShowList, new TodoListModel());
    await waitFor(() => mount.children.length === 1);
    done.resolve({ closed: true });
    await done.promise;
    await waitFor(() => mount.children.length === 0);

    const list = commands.call(uiShowList, new TodoListModel());
    const confirm = commands.call(uiConfirm, new ConfirmModel("Remove?"));
    const menu = commands.call(uiShowMenu, new MenuModel([{ key: "todos:remove" }]));
    // Observed before dispose, so the rejections below are handled.
    const outcomes = Promise.allSettled([list.promise, confirm.promise, menu.promise]);
    await waitFor(() => mount.children.length === 3 && document.querySelector('[role="alertdialog"]') !== null);
    expect(containers()).toEqual(["ui:show-list", "ui:show-dialog:confirm", "ui:show-menu"]);

    await dispose();

    expect(mount.children).toHaveLength(0);
    expect(document.querySelector('[role="alertdialog"]')).toBeNull(); // the portal went with its root
    const settled = await outcomes;
    for (const outcome of settled) {
      expect(outcome.status).toBe("rejected");
      expect(String((outcome as PromiseRejectedResult).reason)).toMatch(/view layer disposed while the view was open/);
    }
    // The command that had already settled keeps its answer.
    await expect(done.promise).resolves.toEqual({ closed: true });

    // The listeners are gone too: a view command now finds nobody — the loud
    // wiring-bug diagnosis, not a hang.
    const late = commands.call(uiShowList, new TodoListModel());
    await expect(late.promise).rejects.toBeInstanceOf(CommandError);
    await expect(late.promise).rejects.toMatchObject({ kind: "no-handlers" });

    // A second dispose (bootstrap's registry is idempotent; so is this) is harmless.
    await dispose();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(rejections).toEqual([]);
  });
});
