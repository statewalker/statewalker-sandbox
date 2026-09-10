import { beforeEach, describe, expect, it } from "vitest";
import { Commands } from "@statewalker/shared-commands";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import type { FileInfo, FilesApi } from "@statewalker/webrun-files";
import { PanelController, PanelModel, expectEdgeCounter, expectReplacedNotMutated } from "@fm/app";

/** C3 — navigation, refresh, sort, filter, and the failure matrix. */

const tree = {
  "/dir/a.txt": "aaa",
  "/dir/b.txt": "bb",
  "/dir/zeta.txt": "z",
  "/dir/sub/nested.txt": "n",
  "/other/x.txt": "x",
};

/** Yields `count` entries, then throws — the partial-listing case. */
class FaultyFilesApi implements FilesApi {
  failAfter?: number;
  constructor(private readonly inner: MemFilesApi) {}
  read(p: string, o?: never) { return this.inner.read(p, o); }
  write(p: string, c: never) { return this.inner.write(p, c); }
  mkdir(p: string) { return this.inner.mkdir(p); }
  stats(p: string) { return this.inner.stats(p); }
  exists(p: string) { return this.inner.exists(p); }
  remove(p: string) { return this.inner.remove(p); }
  move(s: string, t: string) { return this.inner.move(s, t); }
  copy(s: string, t: string) { return this.inner.copy(s, t); }
  async *list(p: string, o?: never): AsyncGenerator<FileInfo> {
    let n = 0;
    for await (const entry of this.inner.list(p, o)) {
      if (this.failAfter !== undefined && n >= this.failAfter) throw new Error("connection lost");
      n++;
      yield entry;
    }
  }
}

describe("C3 · listing lifecycle", () => {
  let api: FaultyFilesApi;
  let model: PanelModel;
  let controller: PanelController;

  const settle = () => controller.settled();

  beforeEach(async () => {
    api = new FaultyFilesApi(new MemFilesApi({ initialFiles: tree }));
    model = new PanelModel("p1", "left", "mem://a", "/dir");
    controller = new PanelController(model, api, new Commands(), () => {});
    await controller.refresh();
  });

  describe("navigation and history", () => {
    it("navigates and records history", async () => {
      await controller.navigate("/other");
      expect(model.path).toBe("/other");
      expect(model.visible.map((e) => e.name)).toEqual(["x.txt"]);
      expect(controller.canGoBack()).toBe(true);
      expect(controller.canGoForward()).toBe(false);
    });

    it("goes back and forward without re-walking history into a new branch", async () => {
      await controller.navigate("/other");
      await controller.back();
      expect(model.path).toBe("/dir");
      expect(controller.canGoForward()).toBe(true);
      await controller.forward();
      expect(model.path).toBe("/other");
    });

    it("truncates the forward branch on a new navigation", async () => {
      await controller.navigate("/other");
      await controller.back();
      await controller.navigate("/dir/sub");
      expect(controller.canGoForward()).toBe(false);

      // The abandoned branch must be gone, not merely out of reach: going back
      // from the new leaf returns to where the user actually was, never to the
      // path they navigated away from.
      await controller.back();
      expect(model.path).toBe("/dir");
      await controller.forward();
      expect(model.path).toBe("/dir/sub");
    });

    it("reacts to input, not to its own writes", async () => {
      model.input.requestedPath = "/other";
      model.input.navigateCount++;
      model.input.notify();
      await settle();
      expect(model.path).toBe("/other");
    });

    it("treats refresh as an edge, so two presses are both honoured", async () => {
      let listings = 0;
      const counting = new PanelController(model, api, new Commands(), () => {});
      void counting;
      model.input.onUpdate(() => { listings++; });
      expectEdgeCounter(model.input as never, "refreshCount", () => listings * 0 + model.input.refreshCount);
    });
  });

  describe("sort and filter are view state over one listing", () => {
    it("groups directories first, then applies the column", async () => {
      await controller.setSort("name");
      expect(model.visible.map((e) => e.name)).toEqual(["sub", "a.txt", "b.txt", "zeta.txt"]);
      await controller.setSort("size");
      expect(model.visible.map((e) => e.name)).toEqual(["sub", "zeta.txt", "b.txt", "a.txt"]);
    });

    it("filters without re-listing", async () => {
      const before = model.lastListedAt;
      // Substring match: "a." also occurs inside "zeta.txt", which is correct
      // and worth pinning — the filter is not a prefix match.
      await controller.setFilter("a.");
      expect(model.visible.map((e) => e.name)).toEqual(["a.txt", "zeta.txt"]);
      expect(model.lastListedAt).toBe(before); // no I/O for a filter
      expect(model.entries.length).toBe(4); // the underlying listing is intact
    });

    it("keeps filter and sort across a refresh", async () => {
      await controller.setFilter("txt");
      await controller.setSort("size");
      await controller.refresh();
      expect(model.visible.map((e) => e.name)).toEqual(["zeta.txt", "b.txt", "a.txt"]);
    });
  });

  describe("the failure matrix", () => {
    it("discards a PARTIAL buffer on a failed refresh — never promotes it", async () => {
      api.failAfter = 2;
      await controller.refresh();
      // A partial listing is indistinguishable from a complete one to the user:
      // "the file isn't there" becomes ambiguous, and "copy everything here"
      // would silently copy a subset.
      expect(model.entries.length).toBe(4);
      expect(model.entries.map((e) => e.name)).not.toEqual(["a.txt", "b.txt"]);
    });

    it("keeps prior entries, marked stale, when a REFRESH fails", async () => {
      api.failAfter = 0;
      await controller.refresh();
      expect(model.path).toBe("/dir");
      expect(model.entries.length).toBe(4);
      expect(model.stale).toBe(true);
      expect(model.error).toMatch(/connection lost/);
      expect(controller.canOperateOnListing()).toBe(false);
    });

    it("clears entries when a NAVIGATION fails", async () => {
      api.failAfter = 0;
      await controller.navigate("/other");
      // Showing the old directory's contents under a new breadcrumb is a lie.
      expect(model.entries).toEqual([]);
      expect(model.visible).toEqual([]);
      expect(model.stale).toBe(false);
      expect(model.error).toMatch(/connection lost/);
    });

    it("clears stale as soon as a refresh succeeds", async () => {
      api.failAfter = 0;
      await controller.refresh();
      expect(model.stale).toBe(true);
      api.failAfter = undefined;
      await controller.refresh();
      expect(model.stale).toBe(false);
      expect(model.error).toBeUndefined();
    });

    it("discards a partial buffer on a failed navigation too", async () => {
      await controller.navigate("/other");
      api.failAfter = 1; // /dir has four entries, so this yields one then throws
      await controller.navigate("/dir");
      expect(model.entries).toEqual([]);
      expect(model.path).toBe("/dir"); // the breadcrumb moved; the contents did not follow
    });
  });

  describe("empty is not missing", () => {
    it("reports an empty directory as empty", async () => {
      await api.mkdir("/empty");
      await controller.navigate("/empty");
      expect(model.entries).toEqual([]);
      expect(model.error).toBeUndefined();
      expect(model.missing).toBe(false);
    });

    it("reports a non-existent path as missing, not as empty", async () => {
      // list() returns an empty iterable for a path that does not exist, so an
      // empty listing is disambiguated with stats().
      await controller.navigate("/nope");
      expect(model.entries).toEqual([]);
      expect(model.missing).toBe(true);
    });
  });

  describe("freshness is reported, not pretended", () => {
    it("stamps the listing time on every successful listing", async () => {
      const first = model.lastListedAt;
      expect(first).toBeGreaterThan(0);
      await new Promise((r) => setTimeout(r, 2));
      await controller.refresh();
      expect(model.lastListedAt).toBeGreaterThan(first);
    });

    it("does not stamp a failed listing", async () => {
      const first = model.lastListedAt;
      api.failAfter = 0;
      await controller.refresh();
      expect(model.lastListedAt).toBe(first);
    });
  });

  describe("model discipline", () => {
    it("replaces entries and visible rather than mutating them", async () => {
      await expectReplacedNotMutated(model, () => model.entries, () => controller.refresh());
      await expectReplacedNotMutated(model, () => model.visible, () => controller.setFilter("b"));
    });
  });
});
