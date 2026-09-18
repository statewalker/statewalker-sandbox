import { describe, expect, it } from "vitest";
import { shell, shellReact, todos, todosReact } from "../../src/features.js";
import { application } from "../../src/kernel/loader.js";
import { all, mount, text, waitFor } from "../support/dom.js";

const noReq = <T extends { requires?: readonly string[] }>(f: T): T => ({ ...f, requires: [] });

describe("late subscriber at the host: any arrival order renders", () => {
  it("model before renderer: a gap until the renderer arrives, then the view", async () => {
    const app = await mount({ id: "model-first", features: [shell, shellReact, todos] });
    await waitFor(() => app.host.querySelector("[data-missing-renderer]") !== null, "a gap");
    const stopUi = await application({ id: "ui", features: [noReq(todosReact)] })(app.context);
    await waitFor(() => all(app.host, 'ul[aria-label="Todos"] li').length === 3, "list rendered");
    await stopUi?.();
    await app.unmount();
  });

  it("renderer before model: nothing to show, then the view when the feature activates", async () => {
    const app = await mount({
      id: "renderer-first",
      features: [shell, shellReact, noReq(todosReact)],
    });
    expect(all(app.host, '[role="tab"]')).toEqual([]);
    const stopTodos = await application({ id: "todos", features: [noReq(todos)] })(app.context);
    await waitFor(() => text(app.host.querySelector("header")).includes("2 open todos"), "count");
    expect(all(app.host, 'ul[aria-label="Todos"] li').length).toBe(3);
    await stopTodos?.();
    await waitFor(() => all(app.host, '[role="tab"]').length === 0, "withdrawn");
    await app.unmount();
  });
});

describe("the intent log viewer", () => {
  it("shows every record of the session, with its origin, payload and outcome", async () => {
    const { workbenchDebug } = await import("../../src/apps/manifests.js");
    const app = await mount(workbenchDebug);
    await waitFor(
      () => all(app.host, '[role="tab"]').some((t) => text(t) === "Intent log"),
      "viewer tab",
    );
    const tabLog = all<HTMLButtonElement>(app.host, '[role="tab"]').find(
      (t) => text(t) === "Intent log",
    );
    tabLog?.click();
    await waitFor(() => all(app.host, 'ol[aria-label="Intent log"] li').length >= 4, "lines");
    const lines = all(app.host, 'ol[aria-label="Intent log"] li').map((l) => text(l));
    expect(lines[0]).toContain("todos.core → todos.core:load");
    expect(lines.some((l) => l.includes("✓") && l.includes("Buy milk"))).toBe(true);
    await app.unmount();
  });
});
