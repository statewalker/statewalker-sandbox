// RECOVERED-FROM-ARCHIVE: notes/drive/2026-09-02.Httpeers-Shell/13-prototype-04-manifest-generation.tar.gz
// Unmodified.
import ts from "typescript";
import { readFileSync } from "node:fs";

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
 * So this walks the TypeScript AST and reads the builder chain
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

/** Unwrap a string literal, or return undefined if it is not statically known. */
function literal(node: ts.Node | undefined): string | undefined {
  if (!node) return undefined;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }
  return undefined;
}

function numberLiteral(node: ts.Node | undefined): number | undefined {
  if (node && ts.isNumericLiteral(node)) return Number(node.text);
  return undefined;
}

/**
 * Walk a builder chain backwards collecting method calls.
 * `Command.async("k").label("L").icon("i").build()` yields
 * [["build"], ["icon","i"], ["label","L"], ["async","k"]].
 */
function chain(node: ts.CallExpression): { name: string; args: ts.NodeArray<ts.Expression> }[] {
  const links: { name: string; args: ts.NodeArray<ts.Expression> }[] = [];
  let current: ts.Expression = node;
  while (ts.isCallExpression(current) && ts.isPropertyAccessExpression(current.expression)) {
    links.push({ name: current.expression.name.text, args: current.arguments });
    current = current.expression.expression;
  }
  return links;
}

/** True if the chain root is the `Command` identifier. */
function rootsAtCommand(node: ts.CallExpression): boolean {
  let current: ts.Expression = node;
  while (ts.isCallExpression(current) && ts.isPropertyAccessExpression(current.expression)) {
    current = current.expression.expression;
  }
  return ts.isIdentifier(current) && current.text === "Command";
}

export async function generateManifest(modulePath: string): Promise<Manifest> {
  const source = readFileSync(modulePath, "utf8");
  const sf = ts.createSourceFile(modulePath, source, ts.ScriptTarget.ES2022, true);

  const commands: ManifestCommand[] = [];
  const menus: ManifestMenuItem[] = [];
  const diagnostics: Diagnostic[] = [];

  const lineOf = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;

  const visit = (node: ts.Node): void => {
    // --- exported command declarations ---
    if (ts.isVariableStatement(node)) {
      const exported = node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
      if (exported) {
        for (const decl of node.declarationList.declarations) {
          const init = decl.initializer;
          if (!init || !ts.isCallExpression(init) || !rootsAtCommand(init)) continue;

          const links = chain(init);
          const policyLink = links[links.length - 1];
          if (!policyLink || !POLICIES.has(policyLink.name)) {
            diagnostics.push({
              kind: "unknown-policy",
              message: `Unrecognised dispatch policy on ${decl.name.getText(sf)}`,
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
              message: `Command key is not a string literal on ${decl.name.getText(sf)}`,
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
            export: decl.name.getText(sf),
          });
        }
      }
    }

    // --- menu contributions ---
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "contributeMenu"
    ) {
      const arg = node.arguments[0];
      if (!arg || !ts.isObjectLiteralExpression(arg)) {
        diagnostics.push({
          kind: "non-literal-menu",
          message: "contributeMenu argument is not an object literal",
          line: lineOf(node),
        });
      } else {
        const prop = (name: string): ts.Expression | undefined => {
          for (const p of arg.properties) {
            if (ts.isPropertyAssignment(p) && p.name.getText(sf) === name) return p.initializer;
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
            line: lineOf(node),
          });
        }
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sf);

  return { module: modulePath, commands, menus, diagnostics };
}
