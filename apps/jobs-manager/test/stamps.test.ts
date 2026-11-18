import { expect, it } from "vitest";
import { nextStamp } from "../src/stamps.ts";

it("stamps are wall-clock time: never ahead of Date.now(), so cleanup(Date.now()) includes a finished job", () => {
  for (let i = 0; i < 1000; i++) expect(nextStamp()).toBeLessThanOrEqual(Date.now());
});

it("stamps are strictly increasing even within one millisecond", () => {
  let previous = 0;
  for (let i = 0; i < 1000; i++) {
    const stamp = nextStamp(previous);
    expect(stamp).toBeGreaterThan(previous);
    previous = stamp;
  }
});
