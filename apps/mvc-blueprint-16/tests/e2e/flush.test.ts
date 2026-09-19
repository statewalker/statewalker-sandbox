import { describe, expect, it } from "vitest";
import { workbench } from "../../src/apps/workbenches.js";
import { click, open, waitFor } from "./dom.js";

/**
 * When does the page reflect a model write? Both interpreters write the DOM inside the model's
 * notification (contract point 4): the DOM one through its group listener, the Solid one through
 * the signal setter. No flush, as for P0's DOM renderers and U1's Solid ones.
 */
describe.each(["dom", "solid"] as const)("flush: %s interpreter", (tech) => {
  it("the count is on the page before submit() returns", async () => {
    const page = await open(workbench(tech));
    const count = () => page.root.querySelector("[data-hello-count]")?.textContent;
    await waitFor(() => count() === "Count: 0");
    click(
      [...page.root.querySelectorAll('[role="menuitem"]')].find(
        (b) => b.textContent === "Say hello",
      ),
    );
    expect(count()).toBe("Count: 1");
    await page.stop();
  });
});
