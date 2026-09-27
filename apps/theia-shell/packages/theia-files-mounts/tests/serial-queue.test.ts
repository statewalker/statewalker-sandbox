import { describe, expect, it } from "vitest";
import { SerialQueue } from "../src/common/serial-queue";

describe("SerialQueue", () => {
  it("runs steps one after another, in order", async () => {
    const queue = new SerialQueue();
    const order: string[] = [];
    const slow = queue.run(async () => {
      await new Promise((r) => setTimeout(r, 20));
      order.push("slow");
    });
    const fast = queue.run(async () => {
      order.push("fast");
    });
    await Promise.all([slow, fast]);
    expect(order).toEqual(["slow", "fast"]);
  });

  it("keeps running after a step fails, and gives the failure to its caller", async () => {
    const queue = new SerialQueue();
    const failed = queue.run(async () => {
      throw new Error("bad glob");
    });
    await expect(failed).rejects.toThrow("bad glob");
    await expect(queue.run(async () => "next")).resolves.toBe("next");
  });
});
