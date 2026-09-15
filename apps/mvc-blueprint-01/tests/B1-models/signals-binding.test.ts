import { implementation } from "@todo/signals";
import { describe, expect, inject, it } from "vitest";
import * as deps from "../../src/lib/signals/deps.js";
import "../support/signals.js";

describe("B1 · which signals this run is on", () => {
  it("@todo/signals resolves to the implementation this project runs", () => {
    // Without this, a matrix whose alias silently fell back to one library
    // would report every rung green twice — and prove nothing the second time.
    expect(implementation).toBe(inject("signals"));
  });

  it("deps.ts — the app's swap point — chooses alien", () => {
    expect(deps.implementation).toBe("alien");
  });
});
