import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Messages } from "../src/common/file-panels-nls";

const source = readFileSync(new URL("../src/common/file-panels-nls.ts", import.meta.url), "utf8");
const calls = [...source.matchAll(/nls\.localize\(\s*"([^"]+)",\s*"((?:[^"\\]|\\.)*)"/g)];

describe("the message catalog", () => {
  it("uses literal, prefixed, unique keys", () => {
    expect(calls.length).toBeGreaterThan(20);
    const keys = calls.map((c) => c[1]);
    for (const key of keys) expect(key).toMatch(/^theia-shell\/file-panels\/[a-zA-Z.]+$/);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("renders every argument and leaves no placeholder", () => {
    const PLURAL = new Set(["transferTitle", "sameFolderTitle", "clashCount", "itemsFailed"]);
    const COUNTS = new Set(["progressStep"]);
    for (const [name, fn] of Object.entries(Messages)) {
      if (PLURAL.has(name) || COUNTS.has(name)) continue;
      const args = Array.from({ length: fn.length }, (_, i) => (i === 0 ? 7 : `‹${i}›`));
      const text = (fn as (...a: unknown[]) => string)(...args);
      expect(text, name).not.toMatch(/\{\d\}/);
      for (const arg of args.slice(1)) expect(text, name).toContain(String(arg));
      expect(text.length, name).toBeGreaterThan(0);
    }
  });

  it("plural messages show the name for one item and the count for several", () => {
    expect(Messages.transferTitle(1, "‹x›", "en")).toContain("‹x›");
    expect(Messages.transferTitle(1, "‹x›", "en")).not.toMatch(/\{\d\}/);
    expect(Messages.transferTitle(7, "‹x›", "en")).toContain("7");
    expect(Messages.transferTitle(7, "‹x›", "en")).not.toMatch(/\{\d\}/);

    expect(Messages.sameFolderTitle(1, "‹x›", "en")).toContain("‹x›");
    expect(Messages.sameFolderTitle(1, "‹x›", "en")).not.toMatch(/\{\d\}/);
    expect(Messages.sameFolderTitle(7, "‹x›", "en")).toContain("7");
    expect(Messages.sameFolderTitle(7, "‹x›", "en")).not.toMatch(/\{\d\}/);

    expect(Messages.clashCount(1, "en")).toContain("1");
    expect(Messages.clashCount(1, "en")).not.toMatch(/\{\d\}/);
    expect(Messages.clashCount(7, "en")).toContain("7");
    expect(Messages.clashCount(7, "en")).not.toMatch(/\{\d\}/);
  });

  it("says how many items failed, plural on the total, counts formatted", () => {
    expect(Messages.itemsFailed(1, 1, "en")).toBe("1 of 1 item failed");
    expect(Messages.itemsFailed(1, 7, "en")).toBe("1 of 7 items failed");
    expect(Messages.itemsFailed(1200, 1500, "en")).toBe("1,200 of 1,500 items failed");
    expect(Messages.itemsFailed(1200, 1500, "de")).toBe("1.200 of 1.500 items failed");
    for (const total of [1, 3, 5, 21]) {
      expect(Messages.itemsFailed(1, total, "ru")).toContain(String(total));
    }
  });

  it("formats the counts of a progress step and a failure line", () => {
    expect(Messages.progressStep(1200, 1500, "en")).toBe("1,200 of 1,500");
    expect(Messages.failureLine("‹a›", "‹b›")).toBe("‹a›: ‹b›");
  });

  it("gives plural messages a text for every Russian category", () => {
    for (const count of [1, 3, 5, 21]) {
      expect(Messages.transferTitle(count, "‹x›", "ru")).not.toBe("");
      expect(Messages.clashCount(count, "ru")).toContain(String(count));
    }
  });

  it("builds copy suffixes", () => {
    expect(Messages.copySuffix(1)).toBe(" copy");
    expect(Messages.copySuffix(2)).toBe(" copy 2");
  });
});
