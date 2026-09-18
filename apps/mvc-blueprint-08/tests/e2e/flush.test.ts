import { flushSync } from "svelte";
import { describe, expect, it } from "vitest";
import { nextTick } from "vue";
import { workbench } from "../../src/apps/workbenches.js";
import { click, open, type Page, waitFor } from "./dom.js";

/**
 * When does the page reflect a model write? The model notifies synchronously, inside the mutator
 * (contract point 4); each technology then schedules its own DOM write. P0 measured plain DOM
 * (synchronous) and React (after its scheduler). Here: Solid writes inside the notification; Svelte
 * and Vue batch to a microtask, and expose a flush (`flushSync()` / `await nextTick()`).
 */
async function ready(tech: "svelte" | "solid" | "vue") {
  const page: Page = await open(workbench(tech));
  const count = () => page.root.querySelector("[data-hello-count]")?.textContent;
  await waitFor(() => count() === "Count: 0");
  /** Clicks "Say hello" and returns what the page shows before anything else runs. */
  const sayHello = () => {
    click(
      [...page.root.querySelectorAll('[role="menuitem"]')].find(
        (b) => b.textContent === "Say hello",
      ),
    );
    return count();
  };
  return { page, count, sayHello };
}

describe("flush per technology", () => {
  it("solid: the count is on the page before submit() returns", async () => {
    const { page, sayHello } = await ready("solid");
    expect(sayHello()).toBe("Count: 1");
    await page.stop();
  });

  it("svelte: not yet after submit(); after flushSync()", async () => {
    const { page, count, sayHello } = await ready("svelte");
    expect(sayHello()).toBe("Count: 0");
    flushSync();
    expect(count()).toBe("Count: 1");
    await page.stop();
  });

  it("vue: not yet after submit(); after await nextTick()", async () => {
    const { page, count, sayHello } = await ready("vue");
    expect(sayHello()).toBe("Count: 0");
    await nextTick();
    expect(count()).toBe("Count: 1");
    await page.stop();
  });
});
