import URI from "@theia/core/lib/common/uri";
import { describe, expect, it } from "vitest";
import {
  collapseCrumbs,
  containingRoot,
  crumbsOf,
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
