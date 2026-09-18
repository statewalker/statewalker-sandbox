import { describe, expect, it } from "vitest";
import type { HelloState } from "../../src/bundles/hello/api/index.js";
import { helloBundle } from "../../src/bundles/hello/index.js";
import { shellFeature } from "../../src/features.js";
import { start } from "../support/headless.js";

describe("hello — the minimal bundle", () => {
  it("contributes a menu item and a panel; the action increments the counter", async () => {
    const h = await start({
      id: "hello",
      features: [shellFeature, { id: "hello", bundles: [helloBundle] }],
    });
    expect(h.menuGroups()).toEqual(["Hello"]);
    expect(h.view<HelloState>("hello")?.count).toBe(0);
    h.dispatch(h.menuAction("Increment"));
    h.dispatch(h.view<HelloState>("hello")?.increment);
    expect(h.view<HelloState>("hello")?.count).toBe(2);
    expect(h.errors()).toEqual([]);
    await h.stop();
  });
});
