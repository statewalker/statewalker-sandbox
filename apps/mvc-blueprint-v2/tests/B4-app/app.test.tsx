import { MemTodoApi } from "@todo/core";
import { userEvent } from "vitest/browser";
import { afterEach, describe, expect, it } from "vitest";
import { type RunningApp, startApp } from "../../src/app.js";
import { button, createHost, waitFor } from "../support/react.js";

let app: RunningApp | undefined;
let host: HTMLElement | undefined;

afterEach(async () => {
  await app?.dispose();
  host?.remove();
  app = undefined;
  host = undefined;
});

const panel = (id: string) => host?.querySelector<HTMLElement>(`[data-panel="${id}"]`) ?? null;
const stat = (name: string) => host?.querySelector(`[data-stat="${name}"]`)?.textContent;
const rowTitles = () =>
  [...(panel("todos:list")?.querySelectorAll("li") ?? [])].map((li) =>
    li.querySelector("label")?.textContent?.trim(),
  );
const inspectorText = () => panel("logs:inspector")?.textContent ?? "";

describe("B4 · the running app", () => {
  it("todos, logs, stats and progress work together through slots, commands and models", async () => {
    host = createHost();
    const unrendered: unknown[] = [];
    app = startApp(host, {
      api: new MemTodoApi([{ id: "s1", title: "seed", done: false }]),
      sampleDelayMs: 20,
      tickMs: 200,
      onUnrendered: (u) => unrendered.push(u),
    });

    // Three panels from three controllers, in two UI technologies.
    await waitFor(
      () => !!panel("todos:list") && !!panel("stats:overview") && !!panel("logs:inspector"),
      3000,
    );
    // The stats controller's RPC to the todo controller seeded the baseline.
    await waitFor(() => stat("open") === "1", 3000);

    await userEvent.fill(
      host.querySelector<HTMLInputElement>('input[aria-label="New todo"]')!,
      "buy milk",
    );
    await userEvent.click(button(host, "Add")!);
    await waitFor(() => rowTitles().includes("buy milk"));
    await waitFor(() => stat("created") === "1");
    await waitFor(
      () => inspectorText().includes("todos:created") && inspectorText().includes("command:call"),
    );

    const milk = [...(panel("todos:list")?.querySelectorAll("li") ?? [])].find((li) =>
      li.textContent?.includes("buy milk"),
    );
    await userEvent.click(milk!.querySelector<HTMLInputElement>('input[type="checkbox"]')!);
    await waitFor(() => stat("closed") === "1");

    // Signals-side operation → plain projection → DOM progress bar.
    await userEvent.click(button(host, "Add sample activity")!);
    await waitFor(() => !!host?.querySelector('[role="progressbar"]'), 3000);
    await waitFor(() => !host?.querySelector('[role="progressbar"]'), 5000);
    await waitFor(() => stat("created") === "6", 3000);

    // A dialog contribution, answered as an edge.
    await userEvent.click(button(host, "Clear completed")!);
    await waitFor(() => document.body.textContent?.includes("Clear 1 completed todo?") ?? false);
    await userEvent.click(button(document.body, "Confirm")!);
    await waitFor(() => !(document.body.textContent?.includes("Clear 1 completed todo?") ?? false));
    await waitFor(() => !rowTitles().includes("buy milk"));
    await waitFor(() => stat("removed") === "1");

    for (const event of ["command:call", "slot:dispose", "model:notify"]) {
      expect(inspectorText(), `the inspector shows ${event}`).toContain(event);
    }
    expect(unrendered, "every contribution had a renderer").toEqual([]);
  }, 20_000);

  it("dispose unmounts everything and empties the root", async () => {
    host = createHost();
    app = startApp(host, { tickMs: 1000 });
    await waitFor(() => !!panel("todos:list"));
    await app.dispose();
    app = undefined;
    expect(host.children).toHaveLength(0);
  });
});
