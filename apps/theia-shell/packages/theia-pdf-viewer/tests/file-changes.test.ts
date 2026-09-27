import URI from "@theia/core/lib/common/uri";
import type { FileChange } from "@theia/filesystem/lib/common/files";
import { describe, expect, it } from "vitest";
import { touchesFile } from "../src/common/file-changes";

// `type` never matters to `touchesFile`; a plain number stands in for it (Theia's
// `FileChangeType` is a `const enum` — unusable at runtime under esbuild/vitest).
const change = (path: string): FileChange => ({ type: 0, resource: new URI(`file://${path}`) });
const uri = (path: string) => new URI(`file://${path}`);

describe("touchesFile", () => {
  it("matches the file itself", () => {
    expect(touchesFile([change("/docs/sample.pdf")], uri("/docs/sample.pdf"))).toBe(true);
  });

  it("matches an ancestor folder, e.g. a mount re-created", () => {
    expect(touchesFile([change("/docs")], uri("/docs/sample.pdf"))).toBe(true);
    expect(touchesFile([change("/")], uri("/docs/sample.pdf"))).toBe(true);
  });

  it("ignores an unrelated file", () => {
    expect(touchesFile([change("/media/gradient.png")], uri("/docs/sample.pdf"))).toBe(false);
  });

  it("ignores a sibling folder with the same prefix", () => {
    expect(touchesFile([change("/docs-2")], uri("/docs/sample.pdf"))).toBe(false);
  });

  it("finds the one ancestor change among several unrelated ones", () => {
    const changes = [
      change("/media/gradient.png"),
      change("/notes/ideas.md"),
      change("/docs"),
      change("/welcome.md"),
    ];
    expect(touchesFile(changes, uri("/docs/sample.pdf"))).toBe(true);
  });

  it("is false for a large batch of unrelated changes (no reload storm)", () => {
    const changes = Array.from({ length: 500 }, (_, i) => change(`/other/${i}.txt`));
    expect(touchesFile(changes, uri("/docs/sample.pdf"))).toBe(false);
  });

  it("is false for no changes", () => {
    expect(touchesFile([], uri("/docs/sample.pdf"))).toBe(false);
  });
});
