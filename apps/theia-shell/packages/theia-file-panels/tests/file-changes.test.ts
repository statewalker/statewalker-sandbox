import URI from "@theia/core/lib/common/uri";
import type { FileChange } from "@theia/filesystem/lib/common/files";
import { describe, expect, it } from "vitest";
import { touchesFile } from "../src/common/file-changes";

// `type` never matters to `touchesFile`; a plain number stands in for it (Theia's
// `FileChangeType` is a `const enum` — unusable at runtime under esbuild/vitest).
const change = (path: string): FileChange => ({ type: 0, resource: new URI(`file://${path}`) });
const uri = (path: string) => new URI(`file://${path}`);

describe("touchesFile", () => {
  it("matches the folder itself", () => {
    expect(touchesFile([change("/cloud/Docs")], uri("/cloud/Docs"))).toBe(true);
  });

  it("matches an ancestor folder, e.g. a mount re-created", () => {
    expect(touchesFile([change("/cloud")], uri("/cloud/Docs"))).toBe(true);
    expect(touchesFile([change("/")], uri("/cloud/Docs"))).toBe(true);
  });

  it("ignores an unrelated folder", () => {
    expect(touchesFile([change("/browser/notes")], uri("/cloud/Docs"))).toBe(false);
  });

  it("ignores a sibling folder with the same prefix", () => {
    expect(touchesFile([change("/cloud-2")], uri("/cloud/Docs"))).toBe(false);
  });

  it("ignores a path below the folder (direction still matters)", () => {
    expect(touchesFile([change("/cloud/Docs/sub")], uri("/cloud/Docs"))).toBe(false);
  });

  it("finds the one ancestor change among several unrelated ones", () => {
    const changes = [
      change("/browser/notes"),
      change("/temp/ideas.md"),
      change("/cloud"),
      change("/welcome.md"),
    ];
    expect(touchesFile(changes, uri("/cloud/Docs"))).toBe(true);
  });

  it("is false for a large batch of unrelated changes (no reload storm)", () => {
    const changes = Array.from({ length: 500 }, (_, i) => change(`/other/${i}.txt`));
    expect(touchesFile(changes, uri("/cloud/Docs"))).toBe(false);
  });

  it("is false for no changes", () => {
    expect(touchesFile([], uri("/cloud/Docs"))).toBe(false);
  });
});
