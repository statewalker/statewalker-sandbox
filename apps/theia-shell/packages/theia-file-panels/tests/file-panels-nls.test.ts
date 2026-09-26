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
    for (const [name, fn] of Object.entries(Messages)) {
      const args = Array.from({ length: fn.length }, (_, i) => (i === 0 ? 7 : `‹${i}›`));
      const text = (fn as (...a: unknown[]) => string)(...args);
      expect(text, name).not.toMatch(/\{\d\}/);
      for (const arg of args.slice(1)) expect(text, name).toContain(String(arg));
      expect(text.length, name).toBeGreaterThan(0);
    }
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
