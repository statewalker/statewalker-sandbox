import URI from "@theia/core/lib/common/uri";
import { describe, expect, it } from "vitest";
import {
  dropOptions,
  freeName,
  invalidDrop,
  planTransfer,
  type TransferRequest,
  type TransferSource,
  validateName,
} from "../src/common/transfer-planner";

const suffix = (n: number) => (n === 1 ? " copy" : ` copy ${n}`);
const u = (path: string) => new URI(`file://${path}`);
const file = (path: string): TransferSource => ({ uri: u(path), isDirectory: false });
const dir = (path: string): TransferSource => ({ uri: u(path), isDirectory: true });
const req = (over: Partial<TransferRequest>): TransferRequest => ({
  sources: [],
  target: u("/b/docs"),
  existing: new Set(),
  op: "copy",
  clash: "keepBoth",
  copySuffix: suffix,
  ...over,
});
const paths = (plan: ReturnType<typeof planTransfer>) =>
  plan.steps.map((s) => `${s.op} ${s.from.path} -> ${s.to.path}${s.overwrite ? " !" : ""}`);

describe("freeName", () => {
  it("inserts the suffix before the first dot of the extension", () => {
    expect(freeName("notes.md", false, new Set(["notes.md"]), suffix)).toBe("notes copy.md");
    expect(freeName("a.tar.gz", false, new Set(["a.tar.gz"]), suffix)).toBe("a copy.tar.gz");
  });
  it("appends to dotfiles and folders", () => {
    expect(freeName(".env", false, new Set([".env"]), suffix)).toBe(".env copy");
    expect(freeName("my.folder", true, new Set(["my.folder"]), suffix)).toBe("my.folder copy");
  });
  it("counts on while the name is taken", () => {
    const taken = new Set(["x.md", "x copy.md", "x copy 2.md"]);
    expect(freeName("x.md", false, taken, suffix)).toBe("x copy 3.md");
  });
  it("uses the injected (localized) suffix", () => {
    expect(freeName("x.md", false, new Set(["x.md"]), (n) => ` Kopie${n > 1 ? ` ${n}` : ""}`)).toBe(
      "x Kopie.md",
    );
  });
});

describe("validateName", () => {
  it("refuses empty, dot names and slashes", () => {
    expect(validateName("")).toBe("empty");
    expect(validateName("   ")).toBe("empty");
    expect(validateName(".")).toBe("dots");
    expect(validateName("..")).toBe("dots");
    expect(validateName("a/b")).toBe("slash");
    expect(validateName("ok.md")).toBeUndefined();
  });
});

describe("invalidDrop", () => {
  it("refuses a folder dropped into itself or a descendant, even in a mixed selection", () => {
    expect(
      invalidDrop([dir("/b/notes"), file("/b/welcome.md")], u("/b/notes"))?.uri.path.base,
    ).toBe("notes");
    expect(invalidDrop([dir("/b/notes")], u("/b/notes/deep"))?.uri.path.base).toBe("notes");
    expect(invalidDrop([dir("/b/notes")], u("/b/notes-2"))).toBeUndefined();
    expect(invalidDrop([file("/b/welcome.md")], u("/b"))).toBeUndefined();
  });
});

describe("dropOptions", () => {
  it("offers copy or rename for one item in its own folder", () => {
    expect(dropOptions([file("/b/docs/a.md")], u("/b/docs"), new Set(["a.md"]))).toEqual({
      ops: ["copy", "rename"],
      allInTarget: true,
      clashing: [],
    });
  });
  it("offers only copy for several items in their own folder", () => {
    expect(
      dropOptions(
        [file("/b/docs/a.md"), file("/b/docs/b.md")],
        u("/b/docs"),
        new Set(["a.md", "b.md"]),
      ).ops,
    ).toEqual(["copy"]);
  });
  it("offers copy or move elsewhere, and lists clashes", () => {
    const o = dropOptions([file("/b/a.md"), file("/b/c.md")], u("/b/docs"), new Set(["a.md"]));
    expect(o).toEqual({ ops: ["copy", "move"], allInTarget: false, clashing: ["a.md"] });
  });
  it("does not count sources already in the target as clashes", () => {
    const o = dropOptions([file("/b/docs/a.md"), file("/b/x.md")], u("/b/docs"), new Set(["a.md"]));
    expect(o.clashing).toEqual([]);
  });
});

describe("planTransfer", () => {
  it("copies into its own folder under a free name", () => {
    const plan = planTransfer(
      req({ sources: [file("/b/docs/a.md")], existing: new Set(["a.md"]) }),
    );
    expect(paths(plan)).toEqual(["copy /b/docs/a.md -> /b/docs/a copy.md"]);
  });

  it("renames with the given name, and a case-only rename is a plain move", () => {
    const rename = (name: string) =>
      paths(
        planTransfer(
          req({
            sources: [file("/b/docs/ideas.md")],
            op: "rename",
            name,
            existing: new Set(["ideas.md"]),
          }),
        ),
      );
    expect(rename("plans.md")).toEqual(["move /b/docs/ideas.md -> /b/docs/plans.md"]);
    expect(rename("Ideas.md")).toEqual(["move /b/docs/ideas.md -> /b/docs/Ideas.md"]);
  });

  it("drops a rename to the same name", () => {
    expect(
      planTransfer(req({ sources: [file("/b/docs/a.md")], op: "rename", name: "a.md" })).steps,
    ).toEqual([]);
  });

  it("moves one item under a typed name, overwriting an existing one", () => {
    const plan = planTransfer(
      req({ sources: [file("/b/a.md")], op: "move", name: "b.md", existing: new Set(["b.md"]) }),
    );
    expect(paths(plan)).toEqual(["move /b/a.md -> /b/docs/b.md !"]);
  });

  it("copies one item in its own folder onto an existing other name, overwriting it", () => {
    const plan = planTransfer(
      req({
        sources: [file("/b/docs/a.md")],
        op: "copy",
        name: "b.md",
        existing: new Set(["a.md", "b.md"]),
      }),
    );
    expect(paths(plan)).toEqual(["copy /b/docs/a.md -> /b/docs/b.md !"]);
  });

  it("copies one item from elsewhere onto the same existing name, overwriting it", () => {
    const plan = planTransfer(
      req({ sources: [file("/b/a.md")], op: "copy", name: "a.md", existing: new Set(["a.md"]) }),
    );
    expect(paths(plan)).toEqual(["copy /b/a.md -> /b/docs/a.md !"]);
  });

  it("applies the clash policy to several items", () => {
    const sources = [file("/b/a.md"), file("/b/c.md")];
    const existing = new Set(["a.md"]);
    expect(paths(planTransfer(req({ sources, existing, op: "move", clash: "overwrite" })))).toEqual(
      ["move /b/a.md -> /b/docs/a.md !", "move /b/c.md -> /b/docs/c.md"],
    );
    expect(paths(planTransfer(req({ sources, existing, op: "move", clash: "keepBoth" })))).toEqual([
      "move /b/a.md -> /b/docs/a copy.md",
      "move /b/c.md -> /b/docs/c.md",
    ]);
    const skip = planTransfer(req({ sources, existing, op: "move", clash: "skip" }));
    expect(paths(skip)).toEqual(["move /b/c.md -> /b/docs/c.md"]);
    expect(skip.skipped.map((s) => [s.uri.path.base, s.reason])).toEqual([["a.md", "clash"]]);
  });

  it("never lets one source overwrite another from the same batch", () => {
    const sources = [file("/b/x/README.md"), file("/b/y/README.md")];
    expect(paths(planTransfer(req({ sources, op: "copy", clash: "overwrite" })))).toEqual([
      "copy /b/x/README.md -> /b/docs/README.md",
      "copy /b/y/README.md -> /b/docs/README copy.md",
    ]);
    const skip = planTransfer(req({ sources, op: "copy", clash: "skip" }));
    expect(paths(skip)).toEqual(["copy /b/x/README.md -> /b/docs/README.md"]);
  });

  it("in a mixed selection, skips moves already in place and gives copies free names", () => {
    const sources = [file("/b/docs/a.md"), file("/b/c.md")];
    const existing = new Set(["a.md"]);
    const move = planTransfer(req({ sources, existing, op: "move" }));
    expect(paths(move)).toEqual(["move /b/c.md -> /b/docs/c.md"]);
    expect(move.skipped.map((s) => s.reason)).toEqual(["alreadyThere"]);
    expect(paths(planTransfer(req({ sources, existing, op: "copy" })))).toEqual([
      "copy /b/docs/a.md -> /b/docs/a copy.md",
      "copy /b/c.md -> /b/docs/c.md",
    ]);
  });

  it("keeps names with spaces, # and % intact", () => {
    const b = new URI("file:///b");
    const plan = planTransfer(
      req({
        sources: [
          { uri: b.resolve("my #1 100%.txt"), isDirectory: false },
          { uri: b.resolve("заметки.md"), isDirectory: false },
        ],
        op: "copy",
      }),
    );
    expect(plan.steps.map((s) => s.to.path.base)).toEqual(["my #1 100%.txt", "заметки.md"]);
    expect(plan.steps[0].to.toString()).toBe(u("/b/docs").resolve("my #1 100%.txt").toString());
  });
});
