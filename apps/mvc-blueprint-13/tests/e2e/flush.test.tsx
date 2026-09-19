import { describe, expect, it } from "vitest";
import { workbenchReact } from "../../src/apps/react.js";
import { click, open, waitFor } from "./dom.js";

/**
 * When does the page reflect a model write? Plain DOM: synchronously, inside the mutator (the
 * binding is a subscribe loop and the contract delivers in process synchronously). React: after
 * its scheduler commits — a test must poll (or wrap in act/flushSync). U1 will add Svelte
 * (flushSync) and Solid (synchronous) rows.
 */
describe("flush per technology", () => {
  it("react: not yet after submit(); after React commits", async () => {
    const page = await open(workbenchReact);
    await waitFor(() => page.root.querySelector("[data-hello-count]") !== null);
    click(
      [...page.root.querySelectorAll('[role="menuitem"]')].find(
        (b) => b.textContent === "Say hello",
      ),
    );
    const immediate = page.root.querySelector("[data-hello-count]")?.textContent;
    await waitFor(() => page.root.querySelector("[data-hello-count]")?.textContent === "Count: 1");
    console.info(`[flush] react, synchronously after submit(): ${immediate}`);
    await page.stop();
  });
});
