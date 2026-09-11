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

  describe("focus", () => {
    // The confirm has no trigger — it is opened by a command, not a button —
    // and it leaves by unmounting its root. Radix returns focus to a trigger,
    // so with none it returned it nowhere, and every answered dialog left the
    // keyboard user on <body>.
    let outside: HTMLButtonElement[];
    const outsideButton = (label: string) => {
      const b = document.createElement("button");
      b.textContent = label;
      document.body.appendChild(b); // not under `mount`: `containers()` counts that
      outside.push(b);
      return b;
    };
    beforeEach(() => {
      outside = [];
    });
    afterEach(() => {
      for (const b of outside) b.remove();
    });

    it("an answered dialog returns focus to the element that had it when the dialog opened", async () => {
      const opener = outsideButton("Clear completed");
      opener.focus();
      expect(document.activeElement).toBe(opener);

      const cmd = commands.call(uiConfirm, new ConfirmModel("Clear 1 completed todo?"));
      await waitFor(() => document.querySelector('[role="alertdialog"]') !== null);
      await waitFor(() => document.activeElement !== opener); // the dialog took focus
      const confirm = [...document.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button')].find(
        (b) => b.textContent === "Confirm",
      );
      confirm!.click();
      await expect(cmd.promise).resolves.toEqual({ confirmed: true });
      await waitFor(() => document.querySelector('[role="alertdialog"]') === null);
      // Radix moves focus on a timer after unmount; give it the turns it takes.
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(document.activeElement, "focus is back where the user was").toBe(opener);
    });

    it("a view that did not hold focus leaves it where it is when it closes", async () => {
      const first = outsideButton("first");
      const second = outsideButton("second");
      first.focus();
      const cmd = commands.call(uiShowList, new TodoListModel());
      await waitFor(() => mount.querySelector("ul") !== null);
      second.focus(); // the user moved on while the panel was up

      cmd.resolve({ closed: true });
      await waitFor(() => mount.children.length === 0);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(document.activeElement, "closing a view must not yank focus back to where it opened").toBe(second);
    });
  });
});
