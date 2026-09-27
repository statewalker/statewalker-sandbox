import { describe, expect, it } from "vitest";
import {
  descriptionKey,
  layoutAreas,
  mountKeyOf,
  startupWait,
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
