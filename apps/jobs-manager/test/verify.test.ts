import { describe, expect, it } from "vitest";
import { verifyJob } from "../src/index.ts";
import type { JobMessage } from "../src/types.ts";

const run: JobMessage[] = [
  { stamp: 1, status: "pending" },
  { stamp: 2, status: "running" },
  { stamp: 3, status: "running", message: { progress: 0.5 } },
  { stamp: 4, status: "running", error: "warning: slow disk" },
  { stamp: 5, status: "running", message: { key: "a/64.bin", size: 64, tags: ["x", "y"] } },
  { stamp: 6, status: "done" },
];

describe("verifyJob", () => {
  it("passes when every expectation holds", () => {
    expect(
      verifyJob(run, {
        status: "done",
        count: 2,
        contains: [{ size: 64 }, { tags: ["x"] }],
        last: { key: "a/64.bin", size: 64, tags: ["x", "y"] },
        expect: [{ progress: 0.5 }, { key: "a/64.bin", size: 64, tags: ["x", "y"] }],
      }),
    ).toEqual({ ok: true, failures: [] });
  });

  it("names each expectation that fails", () => {
    const result = verifyJob(run, {
      status: "error",
      count: 3,
      contains: [{ size: 128 }],
      last: { size: 128 },
      expect: [{ progress: 0.5 }],
    });
    expect(result.ok).toBe(false);
    expect(result.failures).toEqual([
      "status: expected error, got done",
      "count: expected 3 result messages, got 2",
      'contains: no result message matches {"size":128}',
      'last: expected {"size":128}, got {"key":"a/64.bin","size":64,"tags":["x","y"]}',
      "expect: expected 1 result messages, got 2",
    ]);
  });

  it("matches objects as subsets and arrays as element subsets, but scalars exactly", () => {
    expect(verifyJob(run, { contains: [{ tags: ["y"] }] }).ok).toBe(true);
    expect(verifyJob(run, { contains: [{ size: "64" }] }).ok).toBe(false);
    expect(verifyJob(run, { contains: [{ key: "a/64.bin", missing: 1 }] }).ok).toBe(false);
  });
});
