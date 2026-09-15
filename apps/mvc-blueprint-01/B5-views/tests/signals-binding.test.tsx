import { implementation } from "@todo/signals";
import { describe, expect, inject, it } from "vitest";
import "../../test-support/signals.js";

describe("B5 · which signals this browser run is on", () => {
  it("@todo/signals resolves to the implementation this project runs", () => {
    expect(implementation).toBe(inject("signals"));
  });
});
