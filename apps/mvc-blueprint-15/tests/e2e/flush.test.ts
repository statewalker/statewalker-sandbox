import { describe, expect, it } from "vitest";
import { workbench } from "../../src/apps/workbenches.js";
import { click, open, type Page, waitFor } from "./dom.js";

/**
 * When does the page reflect a model write, once json-render sits between the model and the DOM?
 * The model notifies synchronously (contract point 4); the adapter forwards synchronously; then
 * each technology's json-render provider schedules its own DOM write. P0 measured React without
 * json-render (after React's scheduler), U1 Solid without it (inside the notification).
 */
async function sayHello(tech: "react" | "solid") {
  const page: Page = await open(workbench(tech));
  const count = () => page.root.querySelector("[data-hello-count]")?.textContent;
  await waitFor(() => count() === "Count: 0");
  click(
    [...page.root.querySelectorAll('[role="menuitem"]')].find((b) => b.textContent === "Say hello"),
  );
  const sync = count();
  await Promise.resolve();
  const microtask = count();
  await waitFor(() => count() === "Count: 1");
  await page.stop();
  return { sync, microtask };
}

describe("flush per technology, through json-render", () => {
  it("solid: the count is on the page before submit() returns (as without json-render)", async () => {
    const { sync } = await sayHello("solid");
    expect(sync).toBe("Count: 1");
  });

  it("react: not yet after submit(); after React commits (as without json-render)", async () => {
    const { sync, microtask } = await sayHello("react");
    console.info(`[flush] react+jr: sync=${sync} microtask=${microtask}`);
    expect(sync).toBe("Count: 0");
  });
});
