import { describe, expect, it } from "vitest";
import type { MountStatus } from "../src/common/mount-types";
import {
  descriptionKey,
  layoutAreas,
  layoutMountKeys,
  livePending,
  mergePending,
  mountKeyOf,
  type PendingReopen,
  startupWait,
  storedPending,
  unfailedPending,
  within,
} from "../src/common/restore";

const editor = (uri: string) => ({
  factoryId: "code-editor-opener",
  options: { kind: "navigatable", uri, counter: 0 },
});
const desc = (constructionOptions: object) => ({ constructionOptions, innerWidgetState: "{}" });

describe("layoutAreas", () => {
  it("finds each widget description's shell area, however deep the dock layout nests it", () => {
    const notes = editor("file:///cloud/notes.md");
    const log = editor("file:///cloud/log.txt");
    const files = { factoryId: "files", options: undefined };
    const layout = {
      version: "6.0",
      mainPanel: {
        main: {
          type: "split-area",
          children: [
            { type: "tab-area", widgets: [desc(notes)], currentIndex: 0 },
            { type: "tab-area", widgets: [], currentIndex: 0 },
          ],
        },
      },
      bottomPanel: { config: { main: { type: "tab-area", widgets: [desc(log)] } } },
      leftPanel: { items: [{ widget: desc(files), rank: 100, expanded: true }] },
    };
    const areas = layoutAreas(JSON.parse(JSON.stringify(layout)));
    expect(areas.get(descriptionKey(notes))).toBe("main");
    expect(areas.get(descriptionKey(log))).toBe("bottom");
    expect(areas.get(descriptionKey(files))).toBe("left");
    expect(areas.size).toBe(3);
  });

  it("is empty for anything that is not a layout", () => {
    expect(layoutAreas(undefined).size).toBe(0);
    expect(layoutAreas("x").size).toBe(0);
  });
});

describe("mountKeyOf", () => {
  it("is the first path segment of a file-backed widget's `uri` option", () => {
    expect(mountKeyOf({ uri: "file:///cloud/Docs/sample.pdf" })).toBe("cloud");
    expect(mountKeyOf({ uri: "file:///my%20disk/a.md" })).toBe("my disk");
  });

  it("is undefined for widgets that are not backed by a file under a mount", () => {
    expect(mountKeyOf(undefined)).toBeUndefined();
    expect(mountKeyOf({})).toBeUndefined();
    expect(mountKeyOf({ uri: 42 })).toBeUndefined();
    expect(mountKeyOf({ uri: "file:///" })).toBeUndefined();
    expect(mountKeyOf({ uri: "untitled:///Untitled-1" })).toBeUndefined();
    expect(mountKeyOf({ uri: "not a uri" })).toBeUndefined();
  });
});

describe("startupWait", () => {
  it("waits for a mount not applied yet, and for the vault prompt when the mount is locked", () => {
    expect(startupWait(undefined)).toBe("mount");
    expect(startupWait({ state: "locked" })).toBe("vault");
  });

  it("does not wait for a settled mount — nor for one only a click can grant", () => {
    expect(startupWait({ state: "mounted" })).toBeUndefined();
    expect(startupWait({ state: "failed", message: "x" })).toBeUndefined();
    expect(startupWait({ state: "needs-access" })).toBeUndefined();
  });
});

describe("within", () => {
  it("is true when the promise settles in time, rejected or not", async () => {
    expect(await within(Promise.resolve(), 50)).toBe(true);
    expect(await within(Promise.reject(new Error("x")), 50)).toBe(true);
  });

  it("is false when the time runs out first", async () => {
    expect(await within(new Promise(() => undefined), 10)).toBe(false);
  });
});

describe("layoutMountKeys", () => {
  it("is the mounts the shell's file-backed widgets live on, in every area", () => {
    const layout = {
      mainPanel: {
        main: {
          type: "tab-area",
          widgets: [desc(editor("file:///cloud/notes.md")), desc(editor("file:///browser/a.md"))],
        },
      },
      bottomPanel: { config: { main: { widgets: [desc(editor("file:///local/log.txt"))] } } },
      leftPanel: { items: [{ widget: desc({ factoryId: "files" }) }] },
    };
    expect([...layoutMountKeys(JSON.parse(JSON.stringify(layout)))].sort()).toEqual([
      "browser",
      "cloud",
      "local",
    ]);
  });

  it("skips nested widget state (a string) and non-file widgets; empty for no layout", () => {
    const nested = {
      constructionOptions: { factoryId: "outer" },
      innerWidgetState: JSON.stringify({ widgets: [desc(editor("file:///cloud/x.md"))] }),
    };
    expect(layoutMountKeys({ mainPanel: { widgets: [nested] } }).size).toBe(0);
    expect(layoutMountKeys(undefined).size).toBe(0);
  });
});

describe("storedPending and mergePending", () => {
  const pending = (uri: string, area: PendingReopen["area"] = "main"): PendingReopen => ({
    description: desc(editor(uri)),
    area,
  });

  it("keeps only well-formed stored entries", () => {
    const good = pending("file:///cloud/a.md", "bottom");
    expect(storedPending(undefined)).toEqual([]);
    expect(storedPending("x")).toEqual([]);
    expect(
      storedPending([
        good,
        null,
        { area: "main" },
        { ...good, area: "nowhere" },
        { description: {} },
      ]),
    ).toEqual([good]);
  });

  it("merges the new failures with the stored ones, the new first, each widget once", () => {
    const a = pending("file:///cloud/a.md");
    const b = pending("file:///cloud/b.md");
    const aAgain = pending("file:///cloud/a.md", "bottom");
    expect(mergePending([a], [aAgain, b])).toEqual([a, b]);
    expect(mergePending([], [b, b])).toEqual([b]);
  });
});

describe("layoutMountKeys and other widgets", () => {
  it("counts a file: URI among a widget's top-level options or stored state (a files panel)", () => {
    const panel = (options: object, state: object) => ({
      constructionOptions: { factoryId: "file-panel", options },
      innerWidgetState: JSON.stringify(state),
    });
    const layout = {
      mainPanel: {
        widgets: [
          panel({ id: "p1" }, { folder: "file:///cloud/Docs", sort: { column: "name" } }),
          panel({ id: "p2", folder: "file:///local/x" }, {}),
        ],
      },
    };
    expect([...layoutMountKeys(JSON.parse(JSON.stringify(layout)))].sort()).toEqual([
      "cloud",
      "local",
    ]);
  });

  it("does not look deeper (an explorer's expanded folders do not count)", () => {
    const explorer = {
      constructionOptions: { factoryId: "files" },
      innerWidgetState: JSON.stringify({ model: { expanded: ["file:///slow/a"] } }),
    };
    expect(layoutMountKeys({ leftPanel: { items: [{ widget: explorer }] } }).size).toBe(0);
  });
});

describe("livePending and unfailedPending", () => {
  const pending = (uri: string): PendingReopen => ({
    description: desc(editor(uri)),
    area: "main",
  });
  const mount = (key: string, mounted?: boolean) => ({
    key,
    name: key,
    type: "memory",
    config: {},
    ...(mounted === undefined ? {} : { mounted }),
  });

  it("keeps those on a mount in the workspace; drops removed and remembered (mounted: false)", () => {
    const [cloud, kept, gone] = [
      pending("file:///cloud/a.md"),
      pending("file:///kept/b.md"),
      pending("file:///gone/c.md"),
    ];
    expect(
      livePending([cloud, kept, gone], [mount("cloud"), mount("kept", false), mount("x", true)]),
    ).toEqual([cloud]);
  });

  it("drops those whose mount failed; keeps locked, needs-access, mounted, not yet applied", () => {
    const entries = ["failed", "locked", "access", "up", "later"].map((k) =>
      pending(`file:///${k}/f.md`),
    );
    const status = (key: string) =>
      (
        ({
          failed: { state: "failed", message: "x" },
          locked: { state: "locked" },
          access: { state: "needs-access" },
          up: { state: "mounted" },
        }) as Record<string, MountStatus>
      )[key];
    expect(unfailedPending(entries, status)).toEqual(entries.slice(1));
  });
});
