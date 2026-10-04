// RECOVERED-FROM-ARCHIVE: notes/drive/2026-09-02.Httpeers-Shell/13-prototype-04-manifest-generation.tar.gz
// PORTED (2026-10-04) from the TypeScript compiler API, which TypeScript 7 no longer
// ships, to @statewalker/webrun-modules' parseSource (sucrase strips the types, acorn
// parses). The analysis is unchanged: same nodes read, same diagnostics, same lines.

import { readFileSync } from "node:fs";
import { type AcornAst, parseSource } from "@statewalker/webrun-modules";

/**
 * PROTOTYPE 4 — can a manifest be derived from TypeScript source without
 * hand-authoring?
 *
 * The constraint that shapes everything: generation must be **static
 * analysis only**. The module must never be imported. A build environment
 * may not be able to run application code at all — it may import browser
 * globals, hit the network, or simply throw. A manifest that requires
 * executing the thing it describes is not a build-time manifest.
 *
 * So this walks the module's syntax tree and reads the builder chain
 * syntactically. `Command.async("notes:new").label("New Note").build()` is
 * recovered by walking the call chain backwards from `.build()`.
 */

export interface ManifestCommand {
  readonly key: string;
  readonly policy: "async" | "required" | "silent" | "custom";
  readonly label?: string;
  readonly description?: string;
  readonly icon?: string;
  /** Exported symbol name, so a loader can find the live declaration. */
  readonly export: string;
}

export interface ManifestMenuItem {
  readonly location: string;
  readonly command: string;
  readonly group?: string;
  readonly order?: number;
  readonly when?: string;
}

export interface Diagnostic {
  readonly kind: "non-literal-key" | "unknown-policy" | "non-literal-menu";
  readonly message: string;
  readonly line: number;
}

export interface Manifest {
  readonly module: string;
  readonly commands: ManifestCommand[];
  readonly menus: ManifestMenuItem[];
  readonly diagnostics: Diagnostic[];
}

const POLICIES = new Set(["async", "required", "silent", "custom"]);

type Node = AcornAst.Node;
type Expression = AcornAst.Expression;

/** Unwrap a string literal, or return undefined if it is not statically known. */
function literal(node: Node | null | undefined): string | undefined {
  if (!node) return undefined;
  const n = node as AcornAst.AnyNode;
  if (n.type === "Literal" && typeof n.value === "string") return n.value;
  // A template literal without substitutions is as static as a string literal.
  if (n.type === "TemplateLiteral" && n.expressions.length === 0) {
    return n.quasis[0]?.value.cooked ?? undefined;
  }
  return undefined;
}

function numberLiteral(node: Node | null | undefined): number | undefined {
  const n = node as AcornAst.AnyNode | undefined;
  if (n?.type === "Literal" && typeof n.value === "number") return n.value;
  return undefined;
}

/** `a.b` (not `a[b]`): the property name, or undefined. */
function memberName(node: Node): string | undefined {
  const n = node as AcornAst.AnyNode;
  if (n.type !== "MemberExpression" || n.computed || n.property.type !== "Identifier") return undefined;
  return n.property.name;
}

type Link = { name: string; args: (Expression | AcornAst.SpreadElement)[] };

/**
 * Walk a builder chain backwards collecting method calls.
 * `Command.async("k").label("L").icon("i").build()` yields
 * [["build"], ["icon","i"], ["label","L"], ["async","k"]].
 */
function chain(node: AcornAst.CallExpression): Link[] {
  const links: Link[] = [];
  let current: Node = node;
  for (;;) {
    const c = current as AcornAst.AnyNode;
    if (c.type !== "CallExpression") break;
    const name = memberName(c.callee);
    if (name === undefined) break;
    links.push({ name, args: c.arguments });
    current = (c.callee as AcornAst.MemberExpression).object;
  }
  return links;
}

/** True if the chain root is the `Command` identifier. */
function rootsAtCommand(node: AcornAst.CallExpression): boolean {
  let current: Node = node;
  for (;;) {
    const c = current as AcornAst.AnyNode;
    if (c.type !== "CallExpression" || memberName(c.callee) === undefined) break;
    current = (c.callee as AcornAst.MemberExpression).object;
  }
  const root = current as AcornAst.AnyNode;
  return root.type === "Identifier" && root.name === "Command";
}

/** Every child node of `node` (the ESTree equivalent of `ts.forEachChild`). */
function children(node: Node): Node[] {
  const out: Node[] = [];
  for (const [key, value] of Object.entries(node)) {
    if (key === "loc") continue;
    const items = Array.isArray(value) ? value : [value];
    for (const item of items) {
      if (item && typeof item === "object" && typeof (item as Node).type === "string") {
        out.push(item as Node);
      }
    }
  }
  return out;
}

export async function generateManifest(modulePath: string): Promise<Manifest> {
  const source = readFileSync(modulePath, "utf8");
  const format = modulePath.endsWith(".tsx") ? "tsx" : "ts";
  const { js, ast } = parseSource(source, format, modulePath);

  const commands: ManifestCommand[] = [];
  const menus: ManifestMenuItem[] = [];
  const diagnostics: Diagnostic[] = [];

  // sucrase keeps line numbers, so these are the original source's lines.
  const lineOf = (n: Node) => n.loc?.start.line ?? 0;
  const textOf = (n: Node) => js.slice(n.start, n.end);

  const visit = (node: Node): void => {
    const n = node as AcornAst.AnyNode;

    // --- exported command declarations ---
    if (n.type === "ExportNamedDeclaration" && n.declaration?.type === "VariableDeclaration") {
      for (const decl of n.declaration.declarations) {
        const init = decl.init as AcornAst.AnyNode | null | undefined;
        if (!init || init.type !== "CallExpression" || !rootsAtCommand(init)) continue;

        const links = chain(init);
        const policyLink = links[links.length - 1];
        if (!policyLink || !POLICIES.has(policyLink.name)) {
          diagnostics.push({
            kind: "unknown-policy",
            message: `Unrecognised dispatch policy on ${textOf(decl.id)}`,
            line: lineOf(decl),
          });
          continue;
        }

        const key = literal(policyLink.args[0]);
        if (key === undefined) {
          // A template literal or computed key cannot be resolved without
          // executing the module. Report rather than guess.
          diagnostics.push({
            kind: "non-literal-key",
            message: `Command key is not a string literal on ${textOf(decl.id)}`,
            line: lineOf(decl),
          });
          continue;
        }

        const meta = (name: string): string | undefined =>
          literal(links.find((l) => l.name === name)?.args[0]);

        commands.push({
          key,
          policy: policyLink.name as ManifestCommand["policy"],
          label: meta("label"),
          description: meta("description"),
          icon: meta("icon"),
          export: textOf(decl.id),
        });
      }
    }

    // --- menu contributions ---
    if (n.type === "CallExpression" && n.callee.type === "Identifier" && n.callee.name === "contributeMenu") {
      const arg = n.arguments[0] as AcornAst.AnyNode | undefined;
      if (!arg || arg.type !== "ObjectExpression") {
        diagnostics.push({
          kind: "non-literal-menu",
          message: "contributeMenu argument is not an object literal",
          line: lineOf(n),
        });
      } else {
        const prop = (name: string): Expression | undefined => {
          for (const p of arg.properties) {
            if (p.type !== "Property" || p.computed || p.shorthand || p.kind !== "init") continue;
            // As before the port: identifier keys only (a quoted key never matched).
            if (p.key.type === "Identifier" && p.key.name === name) return p.value as Expression;
          }
          return undefined;
        };
        const location = literal(prop("location"));
        const command = literal(prop("command"));
        if (location && command) {
          menus.push({
            location,
            command,
            group: literal(prop("group")),
            order: numberLiteral(prop("order")),
            when: literal(prop("when")),
          });
        } else {
          diagnostics.push({
            kind: "non-literal-menu",
            message: "contributeMenu location/command are not string literals",
            line: lineOf(n),
          });
        }
      }
    }

    for (const child of children(node)) visit(child);
  };

  visit(ast);

  return { module: modulePath, commands, menus, diagnostics };
}
