// DERIVED-FROM-NOTE: 29-Prototypes Z, 6a and 6b: Schema, Build and Design System.md §Prototype Z — "Method: the runtime derivation is the oracle"
//
// RECONSTRUCTION, NOT RECOVERED TESTS. The archived rung reported 16 tests;
// this file has 17 and is not claimed to be the same partition. See
// ../README.md.
//
// The method is the note's, verbatim: "Every test derives the schema twice —
// statically from source text, and at runtime from the real Zod object via the
// same vendor path `shared-commands` uses — and asserts they agree. There is no
// point inventing an independent expectation; agreement with the runtime path
// *is* the requirement."
//
// So each derivation test writes the schema ONCE, as a string. The string is
// what the static deriver parses, and the string is what the oracle evaluates.
// A test cannot drift from its own fixture.

import { Command } from "@statewalker/shared-commands";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { deriveJsonSchema, UnresolvableSchemaError } from "../src/derive.js";

/**
 * The oracle. `shared-commands` derives `inputJsonSchema` through
 * `@standard-community/standard-json`; going through a real
 * `CommandDeclaration` means this is the exact path the shell would use, not a
 * re-implementation of it.
 *
 * `new Function` is the only evaluation in this rung, and it is on the oracle
 * side by design — the point of the rung is that the *deriver* never evaluates.
 */
let probe = 0;
async function runtimeSchema(source: string): Promise<Record<string, unknown>> {
  const schema = new Function("z", `return (${source});`)(z) as z.ZodType;
  const declaration = Command.async(`oracle:${probe++}`)
    .input(schema)
    .output(z.object({}))
    .build();
  return await declaration.inputJsonSchema;
}

/** Derive both ways and assert agreement. Returns the runtime side to pin against. */
async function agree(source: string): Promise<Record<string, unknown>> {
  const runtime = await runtimeSchema(source);
  expect(deriveJsonSchema(source)).toEqual(runtime);
  return runtime;
}

describe("static derivation agrees with the runtime oracle", () => {
  it("derives a flat object of required strings", async () => {
    const runtime = await agree(`z.object({ id: z.string(), title: z.string() })`);
    expect(runtime.required).toEqual(["id", "title"]);
  });

  it("leaves an .optional() property out of required", async () => {
    const runtime = await agree(`z.object({ id: z.string(), title: z.string().optional() })`);
    expect(runtime.required).toEqual(["id"]);
    expect((runtime.properties as Record<string, unknown>).title).toEqual({ type: "string" });
  });

  it("omits `required` entirely when nothing is required (note 39)", async () => {
    // Note 39 records this as one of two Zod-4 quirks the oracle caught on
    // first run: the vendor emits no `required` key rather than `[]`.
    const empty = await agree(`z.object({})`);
    expect(empty).not.toHaveProperty("required");
    const allOptional = await agree(`z.object({ a: z.string().optional() })`);
    expect(allOptional).not.toHaveProperty("required");
  });

  it("carries the safe-integer bounds z.int() emits (note 39)", async () => {
    const runtime = await agree(`z.object({ n: z.int() })`);
    const n = (runtime.properties as Record<string, Record<string, unknown>>).n;
    expect(n.type).toBe("integer");
    expect(n.maximum).toBe(9007199254740991);
    // Note 39 names only the maximum. The oracle also emits a matching negative
    // minimum, which no note mentions — pinned here because it was found, not
    // predicted.
    expect(n.minimum).toBe(-9007199254740991);
  });

  it("treats z.number().int() the same as z.int()", async () => {
    const viaNumber = await agree(`z.object({ n: z.number().int() })`);
    const viaInt = await agree(`z.object({ n: z.int() })`);
    expect(viaNumber).toEqual(viaInt);
  });

  it("derives string length and numeric range bounds", async () => {
    await agree(`z.object({ s: z.string().min(2).max(64) })`);
    await agree(`z.object({ n: z.number().min(0).max(10) })`);
    // An explicit bound REPLACES the safe-integer bound rather than narrowing
    // alongside it. Found from the oracle, not from the note.
    const bounded = await agree(`z.object({ n: z.int().min(0).max(10) })`);
    expect((bounded.properties as Record<string, Record<string, unknown>>).n).toEqual({
      type: "integer",
      minimum: 0,
      maximum: 10,
    });
  });

  it("derives arrays, including arrays of objects and item-count bounds", async () => {
    await agree(`z.object({ tags: z.array(z.string()) })`);
    await agree(`z.object({ tags: z.array(z.string()).min(1).max(3) })`);
    await agree(`z.object({ rows: z.array(z.object({ y: z.int() })) })`);
  });

  it("derives nested objects, sealed at every level", async () => {
    const runtime = await agree(
      `z.object({ outer: z.object({ inner: z.object({ x: z.string() }) }) })`,
    );
    const outer = (runtime.properties as Record<string, Record<string, unknown>>).outer;
    expect(runtime.additionalProperties).toBe(false);
    expect(outer.additionalProperties).toBe(false);
  });

  it("derives a literal enum and a boolean", async () => {
    const runtime = await agree(`z.object({ kind: z.enum(["note", "folder"]), ok: z.boolean() })`);
    expect((runtime.properties as Record<string, unknown>).kind).toEqual({
      type: "string",
      enum: ["note", "folder"],
    });
  });

  it("carries .describe() through as a description", async () => {
    await agree(`z.object({ s: z.string().describe("the title") })`);
    await agree(`z.object({ x: z.string() }).describe("an object")`);
  });

  it("derives the input of a realistic shell command", async () => {
    // The shape rung 04's notes-app fixture declares, plus the metadata a tool
    // projection would want. This is the case the rung exists to serve.
    const runtime = await agree(`z.object({
      title: z.string().min(1).max(120).describe("Note title").optional(),
      folder: z.enum(["inbox", "archive"]),
      order: z.int(),
      tags: z.array(z.string()),
      pinned: z.boolean().optional()
    })`);
    expect(runtime.required).toEqual(["folder", "order", "tags"]);
  });

  it("emits the 2020-12 dialect at the top level only", async () => {
    const runtime = await agree(`z.object({ outer: z.object({ x: z.string() }) })`);
    expect(runtime.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    const outer = (runtime.properties as Record<string, Record<string, unknown>>).outer;
    expect(outer).not.toHaveProperty("$schema");
  });
});

describe("report, never guess", () => {
  // The note's six categories. A wrong schema is worse than a missing one: an
  // agent would build arguments that satisfy the tool interface and then fail
  // validation at the command bus, a long way from the cause.

  const reject = (source: string): UnresolvableSchemaError => {
    let thrown: unknown;
    try {
      deriveJsonSchema(source);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(UnresolvableSchemaError);
    return thrown as UnresolvableSchemaError;
  };

  it("reports a schema referenced by an imported symbol", () => {
    expect(reject(`z.object({ input: NotesInput })`).reason).toBe("imported-symbol");
    expect(reject(`NotesInput.extend({ x: z.string() })`).reason).toBe("imported-symbol");
    expect(reject(`z.object({ title })`).reason).toBe("imported-symbol");
  });

  it("reports a computed enum", () => {
    expect(reject(`z.object({ kind: z.enum(KINDS) })`).reason).toBe("computed-enum");
    expect(reject(`z.object({ kind: z.enum([FIRST, "b"]) })`).reason).toBe("computed-enum");
  });

  it("reports .refine() and .superRefine(), which carry a predicate", () => {
    expect(reject(`z.object({ n: z.int() }).refine((v) => v.n > 0)`).reason).toBe("refinement");
    expect(reject(`z.object({ n: z.int() }).superRefine(() => {})`).reason).toBe("refinement");
  });

  it("reports .transform() and .pipe(), which carry executable code", () => {
    expect(reject(`z.string().transform((s) => s.trim())`).reason).toBe("executable");
    expect(reject(`z.string().pipe(z.int())`).reason).toBe("executable");
  });

  it("reports a non-serialisable type", () => {
    expect(reject(`z.object({ blob: z.instanceof(Blob) })`).reason).toBe("non-serialisable");
    expect(reject(`z.object({ f: z.file() })`).reason).toBe("non-serialisable");
  });

  it("reports an object spread of an unknown shape", () => {
    expect(reject(`z.object({ ...base, x: z.string() })`).reason).toBe("object-spread");
  });

  it("reports the types outside the subset rather than approximating them", () => {
    // The note's own open threads: z.union, z.literal, z.record, z.nullable and
    // dates all throw. Each is easy to add, but each needs its own oracle test,
    // and the safe-integer surprise is the argument for not skipping that.
    for (const source of [
      `z.union([z.string(), z.int()])`,
      `z.literal("note")`,
      `z.record(z.string(), z.string())`,
      `z.string().nullable()`,
      `z.date()`,
      `z.string().default("x")`,
    ]) {
      expect(reject(source).reason).toBe("unsupported-type");
    }
  });

  it("names the offending source so a build log can point at it", () => {
    const error = reject(`z.object({ kind: z.enum(KINDS) })`);
    expect(error.source).toContain("z.enum(KINDS)");
    expect(error.message).toContain("computed-enum");
    expect(error.name).toBe("UnresolvableSchemaError");
  });

  it("emits nothing at all when any part of a schema is underivable", () => {
    // Not a partial schema with the bad property dropped: the whole derivation
    // fails. A silently-shrunk schema is exactly the wrong schema the design
    // rule exists to prevent.
    expect(() =>
      deriveJsonSchema(`z.object({ good: z.string(), bad: z.instanceof(Blob) })`),
    ).toThrow(UnresolvableSchemaError);
  });
});
