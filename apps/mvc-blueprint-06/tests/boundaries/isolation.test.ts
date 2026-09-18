/**
 * The runtime half of "no module-level shared state": two systems in one process, running the same
 * application from the same modules, cannot see each other.
 */
import { describe, expect, it } from "vitest";
import { workbenchHeadless } from "../../src/apps/index.js";
import { list, titles } from "../scenario/scenario.js";
import { findAction, start, waitFor } from "../support/headless.js";

describe("isolation", () => {
  it("two workbenches in one process share nothing", async () => {
    const a = await start(workbenchHeadless());
    const b = await start(workbenchHeadless());
    await waitFor(() => titles(a).length === 3 && titles(b).length === 3);
    a.send("todos:list", { type: "new-title", value: "Only in A" });
    a.dispatch(findAction(list(a)?.toolbar, "Add"));
    await waitFor(() => titles(a).includes("Only in A"));
    expect(titles(b)).not.toContain("Only in A");
    expect(list(b)?.newTitle).toBe("");
    await a.stop();
    expect(titles(b)).toHaveLength(3);
    expect(b.system.addresses().length).toBeGreaterThan(5);
    await b.stop();
  });
});
