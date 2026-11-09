// Acceptance check of a tool bundle, run by the Agent before it loads the code. Pure JS
// (acorn), so it runs on every runtime. It rejects what bundling should have removed:
// imports other than the configured externals, `import()`, `import.meta`, references to
// forbidden free identifiers (eval, Function, require, process, …), and reaching them
// through the global object (`globalThis.process`, `globalThis[x]`).
//
// It is a static check, not a sandbox: computed property access on ordinary objects
// (`({}).constructor.constructor("…")`) cannot be ruled out statically. Where the isolate
// itself has no host file system (workerd) that does not matter; where it has one
// (cellb on Node), only `hostFsRuntimes: "bundled-only"` lets checked bundles run there.

import { parse } from "acorn";
import { simple } from "acorn-walk";
import type { ToolBundleConfig } from "./config.ts";

const GLOBAL_OBJECTS = new Set(["globalThis", "self", "global", "window"]);

export interface CheckResult {
  ok: boolean;
  problems: string[];
}

const matches = (spec: string, patterns: string[]) =>
  patterns.some((p) => (p.endsWith("*") ? spec.startsWith(p.slice(0, -1)) : spec === p));

export function checkToolBundle(code: string, config: ToolBundleConfig): CheckResult {
  const problems: string[] = [];
  let ast: ReturnType<typeof parse>;
  try {
    ast = parse(code, { ecmaVersion: "latest", sourceType: "module", locations: true });
  } catch (e) {
    return { ok: false, problems: [`not a parsable ES module: ${(e as Error).message}`] };
  }
  const forbidden = new Set(config.check.forbidIdentifiers);
  const at = (n: { loc?: { start: { line: number; column: number } } | null }) =>
    n.loc ? ` (${n.loc.start.line}:${n.loc.start.column + 1})` : "";
  // biome-ignore lint/suspicious/noExplicitAny: acorn's estree nodes
  type N = any;
  const source = (n: N) => {
    if (n.source && !matches(String(n.source.value), config.external)) {
      problems.push(`import of '${n.source.value}' is not allowed${at(n)}`);
    }
  };
  // Identifiers that are only names (property keys, member properties), not references.
  const names = new Set<N>();
  simple(ast, {
    MemberExpression(n: N) {
      if (!n.computed) names.add(n.property);
      if (n.object.type === "Identifier" && GLOBAL_OBJECTS.has(n.object.name)) {
        const key = n.computed
          ? n.property.type === "Literal"
            ? String(n.property.value)
            : undefined
          : n.property.name;
        if (key === undefined) problems.push(`computed access on ${n.object.name}${at(n)}`);
        else if (forbidden.has(key)) problems.push(`${n.object.name}.${key}${at(n)}`);
      }
    },
    Property(n: N) {
      if (!n.computed && !n.shorthand) names.add(n.key);
    },
    MethodDefinition(n: N) {
      if (!n.computed) names.add(n.key);
    },
    PropertyDefinition(n: N) {
      if (!n.computed) names.add(n.key);
    },
    ExportSpecifier(n: N) {
      if (n.exported !== n.local) names.add(n.exported);
    },
    ImportDeclaration: source,
    ExportNamedDeclaration: source,
    ExportAllDeclaration: source,
    ImportExpression(n: N) {
      if (config.check.forbidDynamicImport) problems.push(`dynamic import()${at(n)}`);
    },
    MetaProperty(n: N) {
      if (config.check.forbidImportMeta && n.meta.name === "import")
        problems.push(`import.meta${at(n)}`);
    },
  });
  simple(ast, {
    Identifier(n: N) {
      if (forbidden.has(n.name) && !names.has(n)) problems.push(`reference to '${n.name}'${at(n)}`);
    },
  });
  return { ok: problems.length === 0, problems: [...new Set(problems)] };
}
