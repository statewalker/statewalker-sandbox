// RECOVERED-FROM-ARCHIVE: notes/drive/2026-09-02.Httpeers-Shell/13-prototype-04-manifest-generation.tar.gz
// Modified only in the three fixture path literals: the archive ran with the
// prototype's own package root as cwd, this app runs vitest from the app root.
// Every assertion is the archived one.
import { describe, expect, it } from "vitest";
import { generateManifest } from "../src/generate.js";

const FIXTURE = "04-manifest-generation/tests/fixtures/notes-app.ts";

describe("manifest generation from source", () => {
  it("finds exported command declarations without executing the module", async () => {
    const manifest = await generateManifest(FIXTURE);
    const keys = manifest.commands.map((c) => c.key).sort();
    expect(keys).toEqual(["notes:delete", "notes:new"]);
  });

  it("extracts UX metadata from the builder chain", async () => {
    const manifest = await generateManifest(FIXTURE);
    const newNote = manifest.commands.find((c) => c.key === "notes:new");
    expect(newNote?.label).toBe("New Note");
    expect(newNote?.icon).toBe("plus");
    expect(newNote?.description).toBe("Create a new note.");
  });

  it("records the dispatch policy chosen by the builder", async () => {
    const manifest = await generateManifest(FIXTURE);
    expect(manifest.commands.find((c) => c.key === "notes:new")?.policy).toBe("async");
    expect(manifest.commands.find((c) => c.key === "notes:delete")?.policy).toBe("required");
  });

  it("records the exported symbol so a loader can find the declaration", async () => {
    const manifest = await generateManifest(FIXTURE);
    expect(manifest.commands.find((c) => c.key === "notes:new")?.export).toBe("NewNoteCommand");
  });

  it("finds menu contributions and their when clauses", async () => {
    const manifest = await generateManifest(FIXTURE);
    const del = manifest.menus.find((m) => m.command === "notes:delete");
    expect(del?.location).toBe("explorer:context");
    expect(del?.when).toBe('selection("note")');
    expect(del?.group).toBe("edit");
  });

  it("records the module path so contributions can be lazily resolved", async () => {
    const manifest = await generateManifest(FIXTURE);
    expect(manifest.module).toBe(FIXTURE);
  });

  it("does NOT import the module -- generation is static analysis only", async () => {
    // The fixture throws at module scope if evaluated. If generation imported
    // it, this test would fail. That is the whole point: a manifest must be
    // derivable at build time from source that may not even be runnable in
    // the build environment.
    await expect(generateManifest("04-manifest-generation/tests/fixtures/explodes-on-import.ts")).resolves.toBeDefined();
  });

  it("reports an unresolvable key rather than guessing", async () => {
    const manifest = await generateManifest("04-manifest-generation/tests/fixtures/dynamic-key.ts");
    expect(manifest.diagnostics).toContainEqual(
      expect.objectContaining({ kind: "non-literal-key" }),
    );
    expect(manifest.commands).toHaveLength(0);
  });

  it("produces a manifest that is JSON-serialisable", async () => {
    const manifest = await generateManifest(FIXTURE);
    expect(() => JSON.stringify(manifest)).not.toThrow();
    expect(JSON.parse(JSON.stringify(manifest)).commands).toHaveLength(2);
  });
});
