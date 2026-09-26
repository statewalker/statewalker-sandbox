import URI from "@theia/core/lib/common/uri";
import { describe, expect, it } from "vitest";
import type { TransferPlan } from "../src/common/transfer-planner";
import { runPlan, type TransferOps } from "../src/common/transfer-runner";

const u = (p: string) => new URI(`file://${p}`);
const plan: TransferPlan = {
  steps: [
    { op: "copy", from: u("/a/1"), to: u("/b/1"), overwrite: false },
    { op: "move", from: u("/a/2"), to: u("/"), overwrite: false },
    { op: "move", from: u("/a/3"), to: u("/b/3"), overwrite: true },
  ],
  skipped: [],
};

function recorder(failOn?: string): { ops: TransferOps; log: string[] } {
  const log: string[] = [];
  const run = (op: string) => async (from: URI, to: URI, overwrite: boolean) => {
    if (to.path.toString() === failOn) throw new Error(`read-only: ${to.path}`);
    log.push(`${op} ${from.path} ${to.path} ${overwrite}`);
  };
  return { ops: { copy: run("copy"), move: run("move") }, log };
}

describe("runPlan", () => {
  it("runs every step in order with its overwrite flag", async () => {
    const { ops, log } = recorder();
    const outcome = await runPlan(plan, ops);
    expect(log).toEqual(["copy /a/1 /b/1 false", "move /a/2 / false", "move /a/3 /b/3 true"]);
    expect(outcome.done.map((d) => d.path.toString())).toEqual(["/b/1", "/", "/b/3"]);
    expect(outcome.failures).toEqual([]);
  });

  it("keeps going after a failing step and reports it", async () => {
    const { ops, log } = recorder("/");
    const outcome = await runPlan(plan, ops);
    expect(log).toHaveLength(2);
    expect(outcome.failures.map((f) => f.message)).toEqual(["read-only: /"]);
    expect(outcome.done).toHaveLength(2);
  });

  it("stops between steps when cancelled, and reports progress", async () => {
    const { ops, log } = recorder();
    const seen: string[] = [];
    let calls = 0;
    const outcome = await runPlan(plan, ops, {
      isCancelled: () => ++calls > 1,
      onStep: (i, total) => seen.push(`${i}/${total}`),
    });
    expect(log).toHaveLength(1);
    expect(outcome.cancelled).toBe(true);
    expect(seen).toEqual(["0/3"]);
  });
});
