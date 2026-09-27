import URI from "@theia/core/lib/common/uri";
import { describe, expect, it } from "vitest";
import {
  collapseCrumbs,
  containingRoot,
  crumbsOf,
  fallbackAncestors,
  outsideRoots,
  parentWithin,
  siblingSource,
} from "../src/common/breadcrumb-model";

const u = (path: string) => new URI(`file://${path}`);
const show = (crumbs: { uri: URI; isRoot: boolean }[]) =>
  crumbs.map((c) => `${c.uri.path}${c.isRoot ? "*" : ""}`);

describe("crumbsOf", () => {
  it("starts at the single root file:///", () => {
    expect(show(crumbsOf(u("/browser/notes"), [u("/")]))).toEqual([
      "/*",
      "/browser",
      "/browser/notes",
    ]);
    expect(show(crumbsOf(u("/"), [u("/")]))).toEqual(["/*"]);
  });

  it("starts at the deepest root that contains the folder (mounts as roots)", () => {
    const roots = [u("/browser"), u("/tmp"), u("/browser/inner")];
    expect(show(crumbsOf(u("/browser/inner/x"), roots))).toEqual([
      "/browser/inner*",
      "/browser/inner/x",
    ]);
    expect(containingRoot(u("/tmp/a"), roots)?.path.toString()).toBe("/tmp");
  });

  it("falls back to the path root when no root contains the folder", () => {
    expect(show(crumbsOf(u("/elsewhere/a"), [u("/browser")]))).toEqual([
      "/*",
      "/elsewhere",
      "/elsewhere/a",
    ]);
  });
});

describe("collapseCrumbs", () => {
  const crumbs = crumbsOf(u("/a/b/c/d/e"), [u("/")]);
  it("keeps everything that fits", () => {
    expect(collapseCrumbs(crumbs, 6).every((i) => i.kind === "crumb")).toBe(true);
  });
  it("keeps the root and the last ones, hiding the middle behind one item", () => {
    const items = collapseCrumbs(crumbs, 4);
    expect(
      items.map((i) => (i.kind === "crumb" ? i.crumb.uri.path.toString() : `…${i.hidden.length}`)),
    ).toEqual(["/", "…3", "/a/b/c/d", "/a/b/c/d/e"]);
  });
});

describe("siblingSource", () => {
  it("lists the other roots for a root crumb and the parent's folders otherwise", () => {
    const roots = [u("/browser"), u("/tmp")];
    const [root, child] = crumbsOf(u("/browser/notes"), roots);
    expect(siblingSource(root, roots)).toEqual({ kind: "roots", roots });
    const source = siblingSource(child, roots);
    expect(source?.kind === "folder" && source.parent.path.toString()).toBe("/browser");
  });

  it("has nothing for the path root when it is not a workspace root", () => {
    const [root] = crumbsOf(u("/elsewhere"), [u("/browser")]);
    expect(siblingSource(root, [u("/browser")])).toBeUndefined();
  });
});

describe("parentWithin", () => {
  const roots = [u("/browser"), u("/temp")];
  it("goes up inside a root", () => {
    expect(parentWithin(u("/browser/notes"), roots)?.path.toString()).toBe("/browser");
  });
  it("stops at a workspace root: nothing above the mounts is a workspace folder", () => {
    expect(parentWithin(u("/browser"), roots)).toBeUndefined();
    expect(parentWithin(u("/"), [u("/")])).toBeUndefined();
  });
  it("goes up outside every root, down to the path root", () => {
    expect(parentWithin(u("/elsewhere"), roots)?.path.toString()).toBe("/");
    expect(parentWithin(u("/"), roots)).toBeUndefined();
  });
});

describe("fallbackAncestors", () => {
  const paths = (uris: URI[]) => uris.map((uri) => uri.path.toString());
  it("walks up to the containing root, not above it", () => {
    expect(paths(fallbackAncestors(u("/browser/a/b"), [u("/browser"), u("/temp")]))).toEqual([
      "/browser/a",
      "/browser",
    ]);
    expect(fallbackAncestors(u("/browser"), [u("/browser")])).toEqual([]);
  });
  it("has none for a folder of a removed mount, so the panel falls back to the first root", () => {
    expect(fallbackAncestors(u("/cloud/x"), [u("/browser"), u("/temp")])).toEqual([]);
  });
  it("walks to the path root when there is no workspace root", () => {
    expect(paths(fallbackAncestors(u("/a/b"), []))).toEqual(["/a", "/"]);
    expect(paths(fallbackAncestors(u("/a/b"), [u("/")]))).toEqual(["/a", "/"]);
  });
});

describe("outsideRoots", () => {
  const roots = [u("/browser"), u("/temp")];
  it("is true above the roots — the hidden composite a pre-mount-roots layout stored", () => {
    expect(outsideRoots(u("/"), roots)).toBe(true);
    expect(outsideRoots(u("/cloud/x"), roots)).toBe(true);
  });
  it("is false at or inside a root, and whenever there are no roots", () => {
    expect(outsideRoots(u("/browser"), roots)).toBe(false);
    expect(outsideRoots(u("/temp/a/b"), roots)).toBe(false);
    expect(outsideRoots(u("/"), [])).toBe(false);
    expect(outsideRoots(u("/"), [u("/")])).toBe(false);
  });
});
