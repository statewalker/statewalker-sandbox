import {
  expectEdgeCounter,
  expectNoSelfWake,
  expectReplacedNotMutated,
  PanelController,
  PanelModel,
} from "@fm/app";
import { narrowStats, sizeCell } from "@fm/core";
import { Commands } from "@statewalker/shared-commands";
import type { FileInfo, FilesApi, ListOptions } from "@statewalker/webrun-files";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { beforeEach, describe, expect, it } from "vitest";

/**
 * C3 — the listing lifecycle.
 *
 * Written from the records, not from exported code: there is none for this rung.
 * The spine is the failure matrix of
 * [file 11 §2](11-Closing%20the%20Design%20Tree%3A%20Eight%20Threads%20Resolved.md),
 * which supersedes file 08 §11 — three states that must not be conflated, the
 * failure, what is displayed, and what the user may act on.
 */

/** Fails part-way through a listing, after yielding `after` entries. */
class FailingFilesApi extends MemFilesApi {
  failAfter?: number;
  yielded = 0;
  async *list(path: string, options?: ListOptions): AsyncIterable<FileInfo> {
    this.yielded = 0;
    for await (const entry of super.list(path, options)) {
      if (this.failAfter !== undefined && this.yielded >= this.failAfter) {
        throw new Error(`listing failed after ${this.yielded}`);
      }
      this.yielded++;
      yield entry;
    }
  }
}

/** Yields one entry per macrotask, so a second navigation can overtake the first. */
class SlowFilesApi extends MemFilesApi {
  readonly started: string[] = [];
  readonly yieldedPerPath = new Map<string, number>();
  async *list(path: string, options?: ListOptions): AsyncIterable<FileInfo> {
    this.started.push(path);
    for await (const entry of super.list(path, options)) {
      await new Promise((r) => setTimeout(r, 1));
      this.yieldedPerPath.set(path, (this.yieldedPerPath.get(path) ?? 0) + 1);
      yield entry;
    }
  }
}

/** Empty listings reach `stats()`; a slow one widens the window to overtake it. */
class SlowStatsFilesApi extends MemFilesApi {
  async stats(path: string) {
    await new Promise((r) => setTimeout(r, 10));
    return super.stats(path);
  }
}

const tree = () =>
  new MemFilesApi({
    initialFiles: {
      "/home/b.txt": "bb",
      "/home/a.txt": "aaaa",
      "/home/empty.bin": "",
      "/home/zdir/x.txt": "x",
      "/home/adir/y.txt": "y",
      "/other/o.txt": "o",
      "/empty-dir/.keep": "",
    },
  });

interface Harness {
  model: PanelModel;
  controller: PanelController;
  reactions: () => number;
  settle: () => Promise<void>;
}

/**
 * Bootstrap order, as P0 fixed it: bus → view handlers → controllers. The view
 * handler has to exist before `activate()`, or `ui:show-panel` rejects with
 * `no-handlers` — which is the point of declaring it `Command.required`.
 * `activate()` performs the first listing, so nothing here lists twice.
 */
async function build(
  api: FilesApi,
  path: string,
  options: { sortColumns?: ("name" | "size" | "date")[]; release?: () => void } = {},
): Promise<Harness> {
  const { uiShowPanel } = await import("@fm/app");
  const commands = new Commands();
  commands.listen(uiShowPanel, () => true);
  const model = new PanelModel("p1", "left", "mem://a", path);
  let reactions = 0;
  const controller = new PanelController(
    model,
    api,
    commands,
    () => {
      reactions++;
    },
    options,
  );
  const h: Harness = {
    model,
    controller,
    reactions: () => reactions,
    async settle() {
      await controller.settled();
      for (let i = 0; i < 200 && model.loading; i++) await new Promise((r) => setTimeout(r, 2));
      await controller.settled();
      await new Promise((r) => setTimeout(r, 2));
      await controller.settled();
    },
  };
  await controller.activate();
  return h;
}

const harness = (api: FilesApi, path = "/home", options: Parameters<typeof build>[2] = {}) =>
  build(api, path, options);

/** The view writes only into `input`, so every test drives the controller that way. */
const write = (h: Harness, fn: (input: PanelModel["input"]) => void) => {
  fn(h.model.input);
  h.model.input.notify();
  return h.settle();
};

describe("C3 · navigation", () => {
  let h: Harness;

  beforeEach(async () => {
    h = await harness(tree());
  });

  it("lists the new path and moves `path` with it", async () => {
    await write(h, (input) => {
      input.requestedPath = "/other";
      input.navigateCount++;
    });
    expect(h.model.path).toBe("/other");
    expect(h.model.entries.map((e) => e.name)).toEqual(["o.txt"]);
  });

  it("derives breadcrumbs from the path it actually reached", async () => {
    await write(h, (input) => {
      input.requestedPath = "/home/zdir";
      input.navigateCount++;
    });
    expect(h.model.breadcrumbs).toEqual([
      { name: "/", path: "/" },
      { name: "home", path: "/home" },
      { name: "zdir", path: "/home/zdir" },
    ]);
  });

  it("reports the outcome against the intent's own counter", async () => {
    await write(h, (input) => {
      input.requestedPath = "/other";
      input.navigateCount++;
    });
    expect(h.model.lastOutcome).toEqual({ seq: 1, status: "accepted" });
  });

  it("never lets `path` become a requestedPath the panel did not reach", async () => {
    const api = new FailingFilesApi({ initialFiles: { "/home/a.txt": "a", "/other/o.txt": "o" } });
    const g = await build(api, "/home", {});

    api.failAfter = 0;
    await write(g, (input) => {
      input.requestedPath = "/other";
      input.navigateCount++;
    });

    // Otherwise a declined or failed navigation leaves the breadcrumb showing a
    // directory the panel never entered.
    expect(g.model.path).toBe("/home");
    expect(g.model.lastOutcome?.status).toBe("failed");
    expect(g.model.lastOutcome?.seq).toBe(1);
  });

  it("abandons an in-flight listing when a second navigation overtakes it", async () => {
    const api = new SlowFilesApi({
      initialFiles: {
        "/a/1.txt": "1",
        "/a/2.txt": "2",
        "/a/3.txt": "3",
        "/a/4.txt": "4",
        "/b/9.txt": "9",
      },
    });
    const g = await build(api, "/", {});

    g.model.input.requestedPath = "/a";
    g.model.input.navigateCount++;
    g.model.input.notify();
    await new Promise((r) => setTimeout(r, 2));
    g.model.input.requestedPath = "/b";
    g.model.input.navigateCount++;
    g.model.input.notify();
    await g.settle();

    // A listing for the old path is worthless: reads abort and restart.
    expect(g.model.path).toBe("/b");
    expect(g.model.entries.map((e) => e.name)).toEqual(["9.txt"]);
    expect(api.yieldedPerPath.get("/a")).toBeLessThan(4);
  });
});

describe("C3 · refresh", () => {
  it("re-lists the current path and advances the last-listed hint", async () => {
    const api = tree();
    const h = await harness(api);
    const first = h.model.lastListedAt;
    expect(first).toBeDefined();

    await api.write("/home/new.txt", [new TextEncoder().encode("n")]);
    await new Promise((r) => setTimeout(r, 2));
    await write(h, (input) => {
      input.refreshCount++;
    });

    expect(h.model.entries.map((e) => e.name)).toContain("new.txt");
    expect(h.model.lastListedAt).toBeGreaterThan(first as number);
  });

  it("leaves the path alone — a refresh is not a navigation", async () => {
    const h = await harness(tree());
    await write(h, (input) => {
      input.refreshCount++;
    });
    expect(h.model.path).toBe("/home");
    expect(h.model.canGoBack).toBe(false);
  });
});

describe("C3 · history", () => {
  let h: Harness;

  const go = (path: string) =>
    write(h, (input) => {
      input.requestedPath = path;
      input.navigateCount++;
    });

  beforeEach(async () => {
    h = await harness(tree());
  });

  it("goes back to the previous path, and forward again", async () => {
    await go("/other");
    expect(h.model.canGoBack).toBe(true);
    expect(h.model.canGoForward).toBe(false);

    await write(h, (input) => {
      input.backCount++;
    });
    expect(h.model.path).toBe("/home");
    expect(h.model.entries.map((e) => e.name)).toContain("a.txt");
    expect(h.model.canGoForward).toBe(true);

    await write(h, (input) => {
      input.forwardCount++;
    });
    expect(h.model.path).toBe("/other");
  });

  it("does nothing, and does not throw, at either end of the history", async () => {
    const before = h.model.entries;

    await write(h, (input) => {
      input.backCount++;
    });
    expect(h.model.path).toBe("/home");
    expect(h.model.canGoBack).toBe(false);
    // "Does nothing" has to mean nothing: stepping off either end must not fetch
    // an undefined path, which would clear the listing and report it missing.
    expect(h.model.entries).toBe(before);
    expect(h.model.error).toBeUndefined();

    await write(h, (input) => {
      input.forwardCount++;
    });
    expect(h.model.path).toBe("/home");
    expect(h.model.canGoForward).toBe(false);
    expect(h.model.entries).toBe(before);
    expect(h.model.error).toBeUndefined();
  });

  it("truncates the forward history when a new navigation happens after going back", async () => {
    await go("/other");
    await go("/empty-dir");
    await write(h, (input) => {
      input.backCount++;
    });
    expect(h.model.path).toBe("/other");

    await go("/home/zdir");
    expect(h.model.canGoForward).toBe(false);
    expect(h.model.history).toEqual(["/home", "/other", "/home/zdir"]);
  });

  it("does not enter a path the navigation never reached", async () => {
    const api = new FailingFilesApi({ initialFiles: { "/home/a.txt": "a", "/other/o.txt": "o" } });
    const g = await build(api, "/home", {});
    expect(g.model.history).toEqual(["/home"]);

    api.failAfter = 0;
    await write(g, (input) => {
      input.requestedPath = "/other";
      input.navigateCount++;
    });

    // Only a listing that succeeded is somewhere the panel has been.
    expect(g.model.history).toEqual(["/home"]);
    expect(g.model.canGoBack).toBe(false);
  });

  it("replaces the history array rather than mutating it", async () => {
    await expectReplacedNotMutated(
      h.model,
      () => h.model.history,
      () => go("/other"),
    );
  });
});

describe("C3 · sort and filter are a derive stage, not a fetch", () => {
  let h: Harness;

  beforeEach(async () => {
    h = await harness(tree());
  });

  it("groups directories ahead of files in every column", async () => {
    await write(h, (input) => {
      input.sortBy = "name";
    });
    expect(h.model.rows.map((r) => r.name)).toEqual([
      "adir",
      "zdir",
      "a.txt",
      "b.txt",
      "empty.bin",
    ]);

    await write(h, (input) => {
      input.sortBy = "size";
    });
    expect(h.model.rows.map((r) => r.name)).toEqual([
      "adir",
      "zdir",
      "empty.bin",
      "b.txt",
      "a.txt",
    ]);
  });

  it("renders the size cell as a per-row fact, blank for a directory and 0 for an empty file", () => {
    const cell = (name: string) => {
      const row = h.model.rows.find((r) => r.name === name);
      if (!row) throw new Error(`no row named ${name}`);
      return sizeCell(row.stats);
    };
    // A directory shows a blank cell, as every commander does. `size: 0` is the
    // falsy trap a truthiness check would misread as a directory.
    expect(cell("adir")).toBe("");
    expect(cell("empty.bin")).toBe("0");
    expect(cell("b.txt")).toBe("2");
  });

  it("narrows every row through the Stats union", () => {
    for (const row of h.model.rows) {
      expect(() => narrowStats(row.stats)).not.toThrow();
    }
    expect(byKind(h.model.rows, "directory")).toEqual(["adir", "zdir"]);
  });

  it("filters by name without re-listing", async () => {
    const api = new SlowFilesApi({ initialFiles: { "/p/alpha.txt": "a", "/p/beta.txt": "b" } });
    const g = await build(api, "/p", {});
    expect(api.started).toEqual(["/p"]);

    await write(g, (input) => {
      input.filterDraft = "BET";
    });
    expect(g.model.rows.map((r) => r.name)).toEqual(["beta.txt"]);
    // Re-sorting a loaded listing never costs I/O.
    expect(api.started).toEqual(["/p"]);

    await write(g, (input) => {
      input.filterDraft = "";
    });
    expect(g.model.rows.map((r) => r.name)).toEqual(["alpha.txt", "beta.txt"]);
    expect(api.started).toEqual(["/p"]);
  });

  it("does not cancel an in-flight listing when only the sort changes", async () => {
    const api = new SlowFilesApi({
      initialFiles: { "/a/1.txt": "1", "/a/2.txt": "2", "/a/3.txt": "3" },
    });
    const g = await build(api, "/", {});

    g.model.input.requestedPath = "/a";
    g.model.input.navigateCount++;
    g.model.input.notify();
    await new Promise((r) => setTimeout(r, 2));
    g.model.input.sortBy = "size";
    g.model.input.notify();
    await g.settle();

    // The fetch stage is keyed on requestedPath; the derive stage is not
    // abortable and must not abort the fetch either.
    expect(g.model.path).toBe("/a");
    expect(g.model.rows.map((r) => r.name)).toEqual(["1.txt", "2.txt", "3.txt"]);
  });

  it("replaces `rows` rather than mutating them", async () => {
    await expectReplacedNotMutated(
      h.model,
      () => h.model.rows,
      () =>
        write(h, (input) => {
          input.sortBy = "size";
        }),
    );
  });
});

describe("C3 · sorting degrades per storage capability", () => {
  it("offers only the columns the storage can report", async () => {
    // P2's registry declares caps per storage: s3://bucket reports no mtime and
    // loses the date sort while keeping name and size.
    const h = await harness(tree(), "/home", { sortColumns: ["name", "size"] });
    expect(h.model.sortColumns).toEqual(["name", "size"]);
  });

  it("refuses a sort the storage cannot support, as validation rather than an outcome", async () => {
    const h = await harness(tree(), "/home", { sortColumns: ["name", "size"] });
    const before = h.model.rows.map((r) => r.name);

    await write(h, (input) => {
      input.sortBy = "date";
    });

    // Verification is controller work and errors are keys, not prose.
    expect(h.model.errors.sortBy).toEqual({
      key: "fm.sort.unavailable",
      params: { column: "date" },
    });
    // A controller never writes an intent field back — that is a lost-update
    // race and tells the view nothing.
    expect(h.model.input.sortBy).toBe("date");
    expect(h.model.rows.map((r) => r.name)).toEqual(before);
  });

  it("clears the refusal wholesale once a supported column is chosen again", async () => {
    const h = await harness(tree(), "/home", { sortColumns: ["name", "size"] });
    await write(h, (input) => {
      input.sortBy = "date";
    });
    expect(h.model.errors.sortBy).toBeDefined();

    await write(h, (input) => {
      input.sortBy = "size";
    });
    // The whole errors object is replaced per validation pass, so a field that
    // just became valid cannot leave a stale message behind.
    expect(h.model.errors).toEqual({});
    expect(h.model.rows.map((r) => r.name)).toEqual([
      "adir",
      "zdir",
      "empty.bin",
      "b.txt",
      "a.txt",
    ]);
  });

  it("accepts a sort the storage can support, and still writes no intent back", async () => {
    const h = await harness(tree(), "/home", { sortColumns: ["name", "size", "date"] });
    await write(h, (input) => {
      input.sortBy = "date";
    });
    expect(h.model.errors).toEqual({});
    expect(h.model.rows.length).toBe(5);
    // Asserted on BOTH sides of the pair: accepting an intent is not licence to
    // write it back either, or a newer keystroke is lost while the controller
    // was deciding about the older one.
    expect(h.model.input.sortBy).toBe("date");
  });
});

describe("C3 · the failure matrix", () => {
  const seeded = () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 400; i++) files[`/big/f${String(i).padStart(3, "0")}.txt`] = "x";
    files["/other/o.txt"] = "o";
    return new FailingFilesApi({ initialFiles: files });
  };

  it("discards a partial buffer on a failed REFRESH", async () => {
    const api = seeded();
    const h = await build(api, "/big", {});
    expect(h.model.entries.length).toBe(400);

    api.failAfter = 380;
    await write(h, (input) => {
      input.refreshCount++;
    });

    // A partial listing is indistinguishable from a complete one to the user, so
    // "the file isn't there" becomes ambiguous and "copy everything in this
    // directory" would silently copy a subset.
    expect(h.model.entries.length).toBe(400);
    expect(h.model.entries.length).not.toBe(380);
  });

  it("discards a partial buffer on a failed NAVIGATION", async () => {
    const api = seeded();
    const h = await build(api, "/other", {});

    api.failAfter = 380;
    await write(h, (input) => {
      input.requestedPath = "/big";
      input.navigateCount++;
    });

    expect(h.model.entries.length).not.toBe(380);
    expect(h.model.entries).toEqual([]);
  });

  it("keeps prior entries marked stale when a refresh fails", async () => {
    const api = seeded();
    const h = await build(api, "/big", {});

    api.failAfter = 10;
    await write(h, (input) => {
      input.refreshCount++;
    });

    // The content was true recently; cursor and selection stay meaningful and
    // retry is one keystroke.
    expect(h.model.entries.length).toBe(400);
    expect(h.model.stale).toBe(true);
    expect(h.model.error?.key).toBe("fm.listing.failed");
  });

  it("clears entries when a navigation fails", async () => {
    const api = seeded();
    const h = await build(api, "/other", {});

    api.failAfter = 10;
    await write(h, (input) => {
      input.requestedPath = "/big";
      input.navigateCount++;
    });

    // No prior listing exists for the new path; showing the old directory under
    // a new breadcrumb is a lie.
    expect(h.model.entries).toEqual([]);
    expect(h.model.rows).toEqual([]);
    expect(h.model.stale).toBe(false);
    expect(h.model.error?.key).toBe("fm.listing.failed");
  });

  it("clears stale and the error once a listing succeeds again", async () => {
    const api = seeded();
    const h = await build(api, "/big", {});
    api.failAfter = 10;
    await write(h, (input) => {
      input.refreshCount++;
    });
    expect(h.model.stale).toBe(true);

    api.failAfter = undefined;
    await write(h, (input) => {
      input.refreshCount++;
    });
    expect(h.model.stale).toBe(false);
    expect(h.model.error).toBeUndefined();
  });

  it("is never loading once it has settled, whether it succeeded or failed", async () => {
    const api = seeded();
    const h = await build(api, "/big", {});
    expect(h.model.loading).toBe(false);

    api.failAfter = 10;
    await write(h, (input) => {
      input.refreshCount++;
    });
    expect(h.model.loading).toBe(false);
  });
});

describe("C3 · empty is not missing", () => {
  it("reports an empty directory as empty, with no error", async () => {
    const api = new MemFilesApi({ initialFiles: { "/a/keep.txt": "k" } });
    await api.mkdir("/empty");
    const h = await build(api, "/empty", {});

    expect(h.model.entries).toEqual([]);
    expect(h.model.error).toBeUndefined();
  });

  it("reports a missing path as missing, because list() cannot tell you", async () => {
    const api = new MemFilesApi({ initialFiles: { "/a/keep.txt": "k" } });
    const h = await build(api, "/nope", {});

    // list() returns an empty iterable for a non-existent path rather than
    // throwing, so the controller stats() the path to tell them apart.
    expect(h.model.entries).toEqual([]);
    expect(h.model.error).toEqual({ key: "fm.listing.missing", params: { path: "/nope" } });
  });
});

describe("C3 · notification is batched (§6.5)", () => {
  it("notifies a bounded number of times for a 500-entry listing, not once per entry", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 500; i++) files[`/big/f${String(i).padStart(3, "0")}.txt`] = "x";
    const h = await build(new MemFilesApi({ initialFiles: files }), "/big", {});

    let notifies = 0;
    h.model.onUpdate(() => {
      notifies++;
    });
    await h.controller.refresh();

    expect(h.model.entries.length).toBe(500);
    // The assertion is on the count, never on the order or the exact sequence.
    expect(notifies).toBeGreaterThan(0);
    expect(notifies).toBeLessThanOrEqual(8);
  });
});

describe("C3 · an overtaken listing writes nothing, at any await it holds", () => {
  it("abandons a listing overtaken while it was disambiguating empty from missing", async () => {
    // An empty listing is the one path that reaches `stats()`, so it is the one
    // that can be overtaken after its iteration has already finished.
    const api = new SlowStatsFilesApi({ initialFiles: { "/b/9.txt": "9" } });
    await api.mkdir("/empty");
    const g = await build(api, "/b", {});

    g.model.input.requestedPath = "/empty";
    g.model.input.navigateCount++;
    g.model.input.notify();
    await new Promise((r) => setTimeout(r, 2));
    g.model.input.requestedPath = "/b";
    g.model.input.navigateCount++;
    g.model.input.notify();
    await new Promise((r) => setTimeout(r, 40));
    await g.settle();

    expect(g.model.path).toBe("/b");
    expect(g.model.entries.map((e) => e.name)).toEqual(["9.txt"]);
  });

  it("reconciles a tick that asks to navigate AND refresh into one listing", async () => {
    const api = new SlowFilesApi({ initialFiles: { "/a/1.txt": "1", "/b/9.txt": "9" } });
    const g = await build(api, "/a", {});
    const listedBefore = api.started.length;

    // `notify` is one undifferentiated pulse: reconciliation computes the desired
    // state once, it does not replay each counter as a separate event.
    g.model.input.requestedPath = "/b";
    g.model.input.navigateCount++;
    g.model.input.refreshCount++;
    g.model.input.notify();
    await g.settle();

    expect(g.model.path).toBe("/b");
    expect(api.started.length - listedBefore).toBe(1);
  });
});

describe("C3 · loading exposes a growing entry count", () => {
  it("counts entries as they arrive, before the listing is complete", async () => {
    const api = new SlowFilesApi({
      initialFiles: {
        "/a/1.txt": "1",
        "/a/2.txt": "2",
        "/a/3.txt": "3",
        "/a/4.txt": "4",
        "/a/5.txt": "5",
      },
    });
    const h = await build(api, "/", {});

    h.model.input.requestedPath = "/a";
    h.model.input.navigateCount++;
    h.model.input.notify();
    await new Promise((r) => setTimeout(r, 4));

    // Materialise then show, but with an honest loading state: the count is
    // exactly what the storage has handed over, not one behind it.
    expect(h.model.loading).toBe(true);
    expect(h.model.loadedCount).toBeGreaterThan(0);
    expect(h.model.loadedCount).toBeLessThan(5);
    expect(h.model.loadedCount).toBe(api.yieldedPerPath.get("/a"));

    await h.settle();
    expect(h.model.loading).toBe(false);
    expect(h.model.loadedCount).toBe(5);
  });
});

describe("C3 · a refused or failed intent does not clear view-owned level fields", () => {
  it("leaves selection, cursor and scrollTop alone when a navigation fails", async () => {
    const api = new FailingFilesApi({ initialFiles: { "/home/a.txt": "a", "/other/o.txt": "o" } });
    const h = await build(api, "/home", {});
    h.model.input.selection = ["/home/a.txt"];
    h.model.input.cursor = "/home/a.txt";
    h.model.input.scrollTop = 240;

    api.failAfter = 0;
    await write(h, (input) => {
      input.requestedPath = "/other";
      input.navigateCount++;
    });

    // Wiping input would discard newer work the user did while the controller
    // was deciding. A full revert is an explicit user action, not a reaction.
    expect(h.model.input.selection).toEqual(["/home/a.txt"]);
    expect(h.model.input.cursor).toBe("/home/a.txt");
    expect(h.model.input.scrollTop).toBe(240);
  });
});

describe("C3 · model discipline, all three kit helpers (§6.2)", () => {
  let h: Harness;

  beforeEach(async () => {
    h = await harness(tree());
  });

  it("replaces `entries` rather than mutating them", async () => {
    await expectReplacedNotMutated(
      h.model,
      () => h.model.entries,
      () => h.controller.refresh(),
    );
  });

  it("replaces `breadcrumbs` rather than mutating them", async () => {
    await expectReplacedNotMutated(
      h.model,
      () => h.model.breadcrumbs,
      () =>
        write(h, (input) => {
          input.requestedPath = "/other";
          input.navigateCount++;
        }),
    );
  });

  it("cannot be woken by its own controller's writes", async () => {
    await expectNoSelfWake(h.model.input, h.model, h.reactions, () => h.controller.refresh());
  });

  it("holds navigation as an edge counter, so two in one tick are both observed", () => {
    let handled = 0;
    let observed = 0;
    h.model.input.onUpdate(() => {
      observed += h.model.input.navigateCount - handled;
      handled = h.model.input.navigateCount;
    });
    expectEdgeCounter(h.model.input as never, "navigateCount", () => observed);
  });

  it("holds refresh as an edge counter too", () => {
    let handled = 0;
    let observed = 0;
    h.model.input.onUpdate(() => {
      observed += h.model.input.refreshCount - handled;
      handled = h.model.input.refreshCount;
    });
    expectEdgeCounter(h.model.input as never, "refreshCount", () => observed);
  });

  it("exposes `input` as the only writable surface", () => {
    expect(Object.keys(h.model)).toContain("input");
    expect(Object.keys(h.model)).not.toContain("commands");
    expect(Object.keys(h.model)).not.toContain("api");
    expect(Object.keys(h.model)).not.toContain("controller");
  });
});

describe("C3 · cleanup precedes settlement (§6.4)", () => {
  it("releases the storage before ui:show-panel settles", async () => {
    const order: string[] = [];
    const commands = new Commands();
    let viewCmd: { settled: boolean } | undefined;
    const model = new PanelModel("p1", "left", "mem://a", "/home");
    let settledAtRelease: boolean | undefined;
    const controller = new PanelController(model, tree(), commands, () => {}, {
      release: () => {
        settledAtRelease = viewCmd?.settled ?? false;
        order.push("released");
      },
    });

    const { uiShowPanel } = await import("@fm/app");
    commands.listen(uiShowPanel, (cmd) => {
      viewCmd = cmd;
      cmd.promise.then(
        () => order.push("settled"),
        () => order.push("settled"),
      );
      return true;
    });

    await controller.activate();
    controller.dispose();
    const settledWhenReleased = settledAtRelease;
    await new Promise((r) => setTimeout(r, 2));

    // Otherwise an observer that acts on completion races the cleanup. Asserted
    // synchronously as well as through the promise: view removal on settle is a
    // microtask, so the promise alone would order them even if release were late.
    expect(order).toEqual(["released", "settled"]);
    expect(settledWhenReleased).toBe(false);
    expect(viewCmd?.settled).toBe(true);
  });
});

const byKind = (rows: { name: string; stats: { kind: string } }[], kind: string) =>
  rows.filter((r) => r.stats.kind === kind).map((r) => r.name);
