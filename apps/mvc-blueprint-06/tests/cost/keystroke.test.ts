/**
 * What does "a message per keystroke" cost? Measured headlessly: one keystroke = one message to the
 * editor actor + one stream publish (+ whatever subscribes). Prints the numbers for LESSONS.md.
 */
import { describe, expect, it } from "vitest";
import { workbenchHeadless } from "../../src/apps/index.js";
import type { EditorState } from "../../src/bundles/todos/api/index.js";
import { titles } from "../scenario/scenario.js";
import { start, waitFor } from "../support/headless.js";

describe("cost of a message per keystroke", () => {
  it("measures deliveries and time per keystroke in the todo editor", async () => {
    const h = await start(workbenchHeadless());
    await waitFor(() => titles(h).length === 3);
    h.dispatch(h.menuAction("New todo…"));
    let notified = 0;
    const off = h.system.streams.subscribe("todos.edit:view", () => notified++);
    notified = 0;
    const before = h.system.stats().delivered;
    const N = 5000;
    const t0 = performance.now();
    let text = "";
    for (let i = 0; i < N; i++) {
      text += String.fromCharCode(97 + (i % 26));
      h.send("todos:editor", { type: "edit", title: text });
    }
    const ms = performance.now() - t0;
    off();
    const deliveries = h.system.stats().delivered - before;
    expect(h.view<EditorState>("todos:editor")?.title).toBe(text);
    expect(deliveries).toBe(N); // one mailbox delivery per keystroke, nothing else woken
    expect(notified).toBe(N); // one stream notification per keystroke
    console.log(
      JSON.stringify({
        keystrokes: N,
        deliveries,
        notified,
        usPerKeystroke: Math.round((ms / N) * 1000),
      }),
    );
    await h.stop();
  });

  it("counts messages for the whole Todos scenario", async () => {
    const { todosBasics } = await import("../scenario/scenario.js");
    const h = await start(workbenchHeadless({ notifyTimeoutMs: 60_000 }));
    await todosBasics(h);
    console.log(JSON.stringify({ todosScenario: h.system.stats() }));
    await h.stop();
  });
});
