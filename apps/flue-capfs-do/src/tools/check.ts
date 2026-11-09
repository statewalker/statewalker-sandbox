// Acceptance check of a tool bundle, run by the Agent before it loads the code. Pure JS
// (acorn + eslint-scope), so it runs on every runtime. It rejects what bundling should have
// removed: imports other than the configured externals, `import()`, `import.meta`, FREE
// references to forbidden identifiers (eval, Function, require, process, …) — locals of the
// same name are fine — and any use of the global object other than reading a plain,
// non-forbidden property (`globalThis.x`): aliasing it (`const g = globalThis`,
// `const { process: p } = globalThis`), passing it (`Reflect.get(globalThis, …)`) or computed
// access (`globalThis[k]`) is rejected.
//
// It is a static check, NOT a sandbox: the constructors of ordinary functions
// (`({}).constructor.constructor("…")`, `(async () => {}).constructor`) reach code evaluation,
// and no static rule removes them without breaking ordinary code. Where the isolate has no
// host file system (workerd) that does not matter; where it has one (cellb on Node), tools
// run only if their hash is in the deployment's `allowedBundles` (see config.ts).

import { parse } from "acorn";
import { simple } from "acorn-walk";
import { analyze } from "eslint-scope";
import type { ToolBundleConfig } from "./config.ts";

const GLOBAL_OBJECTS = new Set(["globalThis", "self", "global", "window"]);

export interface CheckResult {
  ok: boolean;
  problems: string[];
}

/** esbuild-style patterns: `*` matches any run of characters. */
export function matchesPattern(spec: string, patterns: string[]): boolean {
  return patterns.some((p) => {
    const re = new RegExp(
      `^${p
        .split("*")
        .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
        .join(".*")}$`,
    );
    return re.test(spec);
  });
}

// biome-ignore lint/suspicious/noExplicitAny: acorn's estree nodes
type N = any;

export function checkToolBundle(code: string, config: ToolBundleConfig): CheckResult {
  const problems: string[] = [];
  let ast: N;
  try {
    ast = parse(code, {
      ecmaVersion: "latest",
      sourceType: "module",
      locations: true,
      ranges: true,
    });
  } catch (e) {
    return { ok: false, problems: [`not a parsable ES module: ${(e as Error).message}`] };
  }
  const at = (n: N) => (n?.loc ? ` (${n.loc.start.line}:${n.loc.start.column + 1})` : "");
  const source = (n: N) => {
    if (n.source && !matchesPattern(String(n.source.value), config.external)) {
      problems.push(`import of '${n.source.value}' is not allowed${at(n)}`);
    }
  };
  // Parent links (by start offset of identifiers) for the global-object rule.
  const memberOf = new Map<N, N>(); // identifier node → the MemberExpression it is the object of
  simple(ast, {
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
    MemberExpression(n: N) {
      if (n.object.type === "Identifier") memberOf.set(n.object, n);
    },
  });

  const forbidden = new Set(config.check.forbidIdentifiers);
  let through: { identifier: N }[] = [];
  try {
    through = analyze(ast, { ecmaVersion: 2022, sourceType: "module" }).globalScope?.through ?? [];
  } catch (e) {
    problems.push(`scope analysis failed: ${(e as Error).message}`);
  }
  for (const ref of through) {
    const id = ref.identifier;
    if (forbidden.has(id.name)) {
      problems.push(`reference to '${id.name}'${at(id)}`);
    } else if (GLOBAL_OBJECTS.has(id.name)) {
      const m = memberOf.get(id);
      const key =
        m &&
        (m.computed
          ? m.property.type === "Literal"
            ? String(m.property.value)
            : undefined
          : m.property.name);
      if (key !== undefined && forbidden.has(key)) problems.push(`${id.name}.${key}${at(id)}`);
      else if (config.check.restrictGlobalObject) {
        if (!m) problems.push(`use of ${id.name} other than reading a property${at(id)}`);
        else if (m.computed) problems.push(`computed access on ${id.name}${at(id)}`);
      }
    }
  }
  return { ok: problems.length === 0, problems: [...new Set(problems)] };
}

/** SHA-256 of a bundle as "sha256-<hex>": the id `allowedBundles` lists. */
export async function bundleHash(code: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(code)));
  return `sha256-${Array.from(d, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}
