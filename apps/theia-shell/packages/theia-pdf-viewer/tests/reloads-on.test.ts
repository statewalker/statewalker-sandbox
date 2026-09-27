import URI from "@theia/core/lib/common/uri";
import { FileChangesEvent } from "@theia/filesystem/lib/common/files";
import { describe, expect, it } from "vitest";
import { reloadsOn } from "../src/common/file-changes";

// Theia's `FileChangeType` is a `const enum`: its values, spelled out.
const UPDATED = 0;
const DELETED = 2;
const event = (type: number, path: string) =>
  new FileChangesEvent([{ type, resource: new URI(`file://${path}`) }]);
const file = new URI("file:///docs/sample.pdf");

describe("reloadsOn", () => {
  it("reloads on a change to the file itself, readable or not", () => {
    expect(reloadsOn(event(UPDATED, "/docs/sample.pdf"), file, false)).toBe(true);
    expect(reloadsOn(event(UPDATED, "/docs/sample.pdf"), file, true)).toBe(true);
  });

  it("a readable viewer ignores an ancestor-only change (a files.hidden edit, a mount re-applied)", () => {
    expect(reloadsOn(event(UPDATED, "/"), file, false)).toBe(false);
    expect(reloadsOn(event(UPDATED, "/docs"), file, false)).toBe(false);
  });

  it("an unreadable viewer reloads on an ancestor change: how it recovers", () => {
    expect(reloadsOn(event(UPDATED, "/"), file, true)).toBe(true);
    expect(reloadsOn(event(UPDATED, "/docs"), file, true)).toBe(true);
  });

  it("reloads on a deleted ancestor, as before (Theia's contains)", () => {
    expect(reloadsOn(event(DELETED, "/docs"), file, false)).toBe(true);
  });

  it("ignores unrelated changes", () => {
    expect(reloadsOn(event(UPDATED, "/other/x.txt"), file, true)).toBe(false);
    expect(reloadsOn(event(DELETED, "/docs-2"), file, false)).toBe(false);
  });
});
