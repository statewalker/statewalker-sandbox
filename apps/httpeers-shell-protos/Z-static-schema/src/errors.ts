// DERIVED-FROM-NOTE: 29-Prototypes Z, 6a and 6b: Schema, Build and Design System.md §Prototype Z — "Design rule: report, never guess"
//
// RECONSTRUCTION, NOT RECOVERED CODE. Both archives of this rung
// (26-prototype-Z-static-schema-derivation.tar.gz and
// 26-prototype-04a-zod-static-schema.tar.gz) fail to decompress and no copy
// survives. The note states the method, the design rule and the six categories
// that must throw; it states no signatures. Names and shapes below are
// reconstruction. See ../README.md for exactly what was decided here.

/**
 * Why a construct could not be derived statically.
 *
 * The first six are the note's six categories verbatim. `unsupported-type` is
 * the reconstruction's own: the note's open threads say `z.union`, `z.literal`,
 * `z.record`, `z.nullable` and dates "all throw", but does not say whether they
 * throw the same error. One error class with a reason field is the choice made
 * here, because the caller's decision is identical in every case — do not emit
 * a schema.
 */
export type UnresolvableReason =
  /** A schema referenced by an imported symbol rather than written inline. */
  | "imported-symbol"
  /** `z.enum(KINDS)` — members not literal. */
  | "computed-enum"
  /** `.refine()` / `.superRefine()` — carries a predicate function. */
  | "refinement"
  /** `.transform()` / `.pipe()` — carries executable code. */
  | "executable"
  /** `z.instanceof(Blob)` and friends — no JSON representation. */
  | "non-serialisable"
  /** `z.object({ ...base, x: z.string() })` — spread of an unknown shape. */
  | "object-spread"
  /** Outside the subset the shell uses; see the note's open threads. */
  | "unsupported-type";

/**
 * Thrown instead of emitting an approximate schema.
 *
 * The note's justification, kept here because it is the reason this class
 * exists at all: "A wrong schema is worse than a missing one — an agent would
 * construct arguments that satisfy the tool interface and then fail validation
 * at the command bus, a confusing failure a long way from its cause."
 */
export class UnresolvableSchemaError extends Error {
  readonly reason: UnresolvableReason;
  /** The offending source text, so a build log can point at it. */
  readonly source: string;

  constructor(reason: UnresolvableReason, source: string, detail: string) {
    super(`${reason}: ${detail} (in \`${source}\`)`);
    this.name = "UnresolvableSchemaError";
    this.reason = reason;
    this.source = source;
  }
}
