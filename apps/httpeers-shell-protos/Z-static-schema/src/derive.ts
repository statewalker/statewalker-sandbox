// DERIVED-FROM-NOTE: 29-Prototypes Z, 6a and 6b: Schema, Build and Design System.md §Prototype Z
//
// RECONSTRUCTION, NOT RECOVERED CODE. See ./errors.ts and ../README.md.
//
// PROTOTYPE Z — can JSON Schema be derived statically from a Zod expression,
// without executing the module?
//
// This is the top-ranked open thread of rung 04. That rung derives keys,
// policies and UX metadata from source but not `inputJsonSchema`, and
// projection to OpenAPI and MCP tools depends on the schema. If the schema can
// only be obtained by evaluating the module, projection stays a runtime concern
// and the build-time manifest story weakens.
//
// Two rules carry over from rung 04 and are the whole design:
//
//   1. Never execute the source. The input here is an expression *string*; it
//      is parsed, never evaluated. (The note is explicit that this rung does
//      not integrate with rung 04's generator — it derives from an expression,
//      not from a command declaration in a real module.)
//   2. Report, never guess. Anything outside the derivable subset throws
//      `UnresolvableSchemaError` rather than producing an approximation.
//
// The TypeScript compiler API is the parser, as at rung 04 — hence the app's
// `typescript@5.9.3` pin. TypeScript 7 ships no `createSourceFile`.

import ts from "typescript";
import { UnresolvableSchemaError } from "./errors.js";

export type { UnresolvableReason } from "./errors.js";
export { UnresolvableSchemaError } from "./errors.js";

/** A derived JSON Schema node. Deliberately loose: the oracle decides shape. */
export type JsonSchema = Record<string, unknown>;

const DIALECT = "https://json-schema.org/draft/2020-12/schema";

/**
 * Zod 4 emits an explicit safe-integer range for integers. Note 39 records the
 * maximum; the runtime oracle showed a matching negative minimum, which the
 * note does not mention. Both are pinned by test.
 */
const SAFE_INT_MAX = Number.MAX_SAFE_INTEGER; // 9007199254740991
const SAFE_INT_MIN = -Number.MAX_SAFE_INTEGER;

/** Base constructors this rung derives. Everything else is reported. */
const BASE = new Set(["object", "string", "number", "int", "boolean", "array", "enum"]);

/** Base constructors with no JSON representation at all. */
const NON_SERIALISABLE = new Set([
  "instanceof",
  "custom",
  "file",
  "function",
  "promise",
  "map",
  "set",
  "symbol",
  "void",
  "never",
  "bigint",
  "nan",
]);

/** Chain links that carry executable code. */
const EXECUTABLE = new Set(["transform", "pipe"]);
const REFINING = new Set(["refine", "superRefine", "check"]);

interface Link {
  readonly name: string;
  readonly args: ts.NodeArray<ts.Expression>;
  readonly node: ts.CallExpression;
}

interface Derived {
  readonly schema: JsonSchema;
  /** True when the property carrying this schema must be left out of `required`. */
  readonly optional: boolean;
}

/**
 * Walk a Zod builder chain and return it root-first.
 * `z.string().min(2).optional()` yields root `z` and
 * [string, min, optional].
 */
function chainOf(node: ts.Expression): { links: Link[]; root: ts.Expression } {
  const links: Link[] = [];
  let current: ts.Expression = node;
  while (ts.isCallExpression(current) && ts.isPropertyAccessExpression(current.expression)) {
    links.push({ name: current.expression.name.text, args: current.arguments, node: current });
    current = current.expression.expression;
  }
  links.reverse();
  return { links, root: current };
}

function textOf(node: ts.Node, sf: ts.SourceFile): string {
  return node.getText(sf).replace(/\s+/g, " ").slice(0, 120);
}

function stringLiteral(node: ts.Node | undefined): string | undefined {
  if (!node) return undefined;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return undefined;
}

function numericLiteral(node: ts.Node | undefined): number | undefined {
  if (!node) return undefined;
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (
    ts.isPrefixUnaryExpression(node) &&
    node.operator === ts.SyntaxKind.MinusToken &&
    ts.isNumericLiteral(node.operand)
  ) {
    return -Number(node.operand.text);
  }
  return undefined;
}

/** Derive one expression node. Recursive: objects and arrays derive their parts. */
function deriveNode(node: ts.Expression, sf: ts.SourceFile): Derived {
  const src = textOf(node, sf);

  // A bare symbol — `NotesInput`, `shared.Schema` — is a schema this rung
  // cannot see. Category 1.
  if (!ts.isCallExpression(node)) {
    if (ts.isIdentifier(node) || ts.isPropertyAccessExpression(node)) {
      throw new UnresolvableSchemaError(
        "imported-symbol",
        src,
        "schema is referenced by symbol, not written inline",
      );
    }
    throw new UnresolvableSchemaError("unsupported-type", src, "not a Zod expression");
  }

  const { links, root } = chainOf(node);

  if (!ts.isIdentifier(root) || root.text !== "z") {
    // `NotesInput.extend({...})` — a chain rooted at an imported schema.
    throw new UnresolvableSchemaError(
      "imported-symbol",
      src,
      "chain does not start at the `z` namespace",
    );
  }

  const [base, ...modifiers] = links;
  if (!base) {
    throw new UnresolvableSchemaError("unsupported-type", src, "empty Zod chain");
  }

  let schema = deriveBase(base, sf);
  let optional = false;

  for (const link of modifiers) {
    if (EXECUTABLE.has(link.name)) {
      throw new UnresolvableSchemaError(
        "executable",
        src,
        `.${link.name}() carries executable code`,
      );
    }
    if (REFINING.has(link.name)) {
      throw new UnresolvableSchemaError(
        "refinement",
        src,
        `.${link.name}() carries a predicate function`,
      );
    }
    schema = applyModifier(schema, link, src, sf, () => {
      optional = true;
    });
  }

  return { schema, optional };
}

function deriveBase(base: Link, sf: ts.SourceFile): JsonSchema {
  const src = textOf(base.node, sf);

  if (NON_SERIALISABLE.has(base.name)) {
    throw new UnresolvableSchemaError(
      "non-serialisable",
      src,
      `z.${base.name}() has no JSON Schema representation`,
    );
  }
  if (!BASE.has(base.name)) {
    // z.union, z.literal, z.record, z.nullable, dates, tuples, ...
    // The note's open threads: "each is easy to add, but each needs its own
    // oracle test". Until it has one, it is reported.
    throw new UnresolvableSchemaError(
      "unsupported-type",
      src,
      `z.${base.name}() is outside the derivable subset`,
    );
  }

  switch (base.name) {
    case "string":
      return { type: "string" };
    case "number":
      return { type: "number" };
    case "boolean":
      return { type: "boolean" };
    case "int":
      return { type: "integer", minimum: SAFE_INT_MIN, maximum: SAFE_INT_MAX };
    case "array":
      return deriveArray(base, sf);
    case "enum":
      return deriveEnum(base, sf);
    default:
      return deriveObject(base, sf);
  }
}

function deriveArray(base: Link, sf: ts.SourceFile): JsonSchema {
  const item = base.args[0];
  if (!item) {
    throw new UnresolvableSchemaError(
      "unsupported-type",
      textOf(base.node, sf),
      "z.array() with no element schema",
    );
  }
  return { type: "array", items: deriveNode(item, sf).schema };
}

function deriveEnum(base: Link, sf: ts.SourceFile): JsonSchema {
  const arg = base.args[0];
  const src = textOf(base.node, sf);
  if (!arg || !ts.isArrayLiteralExpression(arg)) {
    // `z.enum(KINDS)` — category 2. The members live in a value this rung
    // would have to execute the module to read.
    throw new UnresolvableSchemaError(
      "computed-enum",
      src,
      "enum members are not an array literal",
    );
  }
  const members: string[] = [];
  for (const element of arg.elements) {
    const value = stringLiteral(element);
    if (value === undefined) {
      throw new UnresolvableSchemaError(
        "computed-enum",
        src,
        "an enum member is not a string literal",
      );
    }
    members.push(value);
  }
  return { type: "string", enum: members };
}

function deriveObject(base: Link, sf: ts.SourceFile): JsonSchema {
  const arg = base.args[0];
  const src = textOf(base.node, sf);
  if (!arg || !ts.isObjectLiteralExpression(arg)) {
    throw new UnresolvableSchemaError(
      "imported-symbol",
      src,
      "z.object() shape is not an object literal",
    );
  }

  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];

  for (const property of arg.properties) {
    if (ts.isSpreadAssignment(property)) {
      // Category 6. The spread source could add or remove any key.
      throw new UnresolvableSchemaError(
        "object-spread",
        textOf(property, sf),
        "object shape includes a spread of an unknown shape",
      );
    }
    if (ts.isShorthandPropertyAssignment(property)) {
      throw new UnresolvableSchemaError(
        "imported-symbol",
        textOf(property, sf),
        "shorthand property refers to a symbol this rung cannot read",
      );
    }
    if (!ts.isPropertyAssignment(property)) {
      throw new UnresolvableSchemaError(
        "unsupported-type",
        textOf(property, sf),
        "object shape member is not a property assignment",
      );
    }

    const name = ts.isIdentifier(property.name) ? property.name.text : stringLiteral(property.name);
    if (name === undefined) {
      throw new UnresolvableSchemaError(
        "unsupported-type",
        textOf(property, sf),
        "property name is computed",
      );
    }

    const derived = deriveNode(property.initializer, sf);
    properties[name] = derived.schema;
    if (!derived.optional) required.push(name);
  }

  const schema: JsonSchema = { type: "object", properties };
  // Note 39: "`required` is omitted when empty" — the vendor emits no key
  // rather than `[]`. Pinned by test against the runtime oracle.
  if (required.length > 0) schema.required = required;
  schema.additionalProperties = false;
  return schema;
}

function applyModifier(
  schema: JsonSchema,
  link: Link,
  src: string,
  sf: ts.SourceFile,
  markOptional: () => void,
): JsonSchema {
  switch (link.name) {
    case "optional": {
      markOptional();
      return schema;
    }
    case "describe": {
      const text = stringLiteral(link.args[0]);
      if (text === undefined) {
        throw new UnresolvableSchemaError(
          "unsupported-type",
          src,
          ".describe() argument is not a string literal",
        );
      }
      return { ...schema, description: text };
    }
    case "int": {
      if (schema.type !== "number") {
        throw new UnresolvableSchemaError(
          "unsupported-type",
          src,
          ".int() applies only to z.number()",
        );
      }
      return { type: "integer", minimum: SAFE_INT_MIN, maximum: SAFE_INT_MAX };
    }
    case "min":
    case "max":
      return applyBound(schema, link, src, sf);
    default:
      // `.default()`, `.catch()`, `.nullable()`, `.brand()`, `.readonly()`, ...
      throw new UnresolvableSchemaError(
        "unsupported-type",
        src,
        `.${link.name}() is outside the derivable subset`,
      );
  }
}

function applyBound(schema: JsonSchema, link: Link, src: string, sf: ts.SourceFile): JsonSchema {
  const value = numericLiteral(link.args[0]);
  if (value === undefined) {
    throw new UnresolvableSchemaError(
      "unsupported-type",
      src,
      `.${link.name}() bound is not a numeric literal`,
    );
  }
  const upper = link.name === "max";
  switch (schema.type) {
    case "string":
      return { ...schema, [upper ? "maxLength" : "minLength"]: value };
    case "number":
    case "integer":
      // Deliberately overwrites the safe-integer bound: the runtime oracle
      // shows an explicit `.min()/.max()` replacing it rather than narrowing
      // alongside it.
      return { ...schema, [upper ? "maximum" : "minimum"]: value };
    case "array":
      return { ...schema, [upper ? "maxItems" : "minItems"]: value };
    default:
      throw new UnresolvableSchemaError(
        "unsupported-type",
        src,
        `.${link.name}() has no meaning on ${String(schema.type)}`,
      );
  }
}

/**
 * Derive a JSON Schema from the *text* of a Zod expression.
 *
 * @param expression e.g. `z.object({ title: z.string().optional() })`
 * @throws UnresolvableSchemaError for anything outside the derivable subset.
 */
export function deriveJsonSchema(expression: string): JsonSchema {
  const sf = ts.createSourceFile(
    "<zod-expression>.ts",
    `const __schema = (${expression});`,
    ts.ScriptTarget.ES2022,
    true,
  );

  const statement = sf.statements[0];
  if (!statement || !ts.isVariableStatement(statement)) {
    throw new UnresolvableSchemaError("unsupported-type", expression, "not a single expression");
  }
  const initializer = statement.declarationList.declarations[0]?.initializer;
  if (!initializer) {
    throw new UnresolvableSchemaError("unsupported-type", expression, "expression is empty");
  }

  let node: ts.Expression = initializer;
  while (ts.isParenthesizedExpression(node)) node = node.expression;

  const { schema } = deriveNode(node, sf);
  return { $schema: DIALECT, ...schema };
}
