// DERIVED-FROM-NOTE: 29-Prototypes Z, 6a and 6b: Schema, Build and Design System
//   §"Prototype 6b — the Basecoat mapping"
//   §"Security: classes come from the mapping, never the message"
//   §"Prototype 6a — Tailwind build" / §"A packaging trap"
// DERIVED-FROM-NOTE: lib/ORIGIN.md findings 4 and 5
//
// This file is RECONSTRUCTED, not recovered. Rung 6b's archive predates the
// two corrections rung 7 made to the mapping, so the archive has no test for
// either. These pin them — and pin them against the REAL shipped
// `basecoat-css@1.0.2` files rather than against a claim, because that is
// what made both corrections expensive: they were only found by rendering
// against the actual bundle.

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { beforeEach, describe, expect, it } from "vitest";
import { BASECOAT_CLASSES, classesFor, dataVariantFor } from "../../lib/basecoat.js";
import { shellCatalog } from "../../lib/catalog.js";
import { type A2uiMessage, createRenderer } from "../../lib/renderer.js";

const require = createRequire(import.meta.url);
const bcDir = require.resolve("basecoat-css/package.json").replace(/package\.json$/, "dist/");
const read = (f: string) => readFileSync(bcDir + f, "utf8");

/** The default prebuilt style pack — what 6a recommends shipping. */
const DEFAULT_PACK = read("basecoat.cdn.min.css");
/** The bare component pack 6a actually measured at 12 KB gzipped. */
const BASE_PACK = read("basecoat-base.cdn.min.css");
/** The optional legacy stylesheet, the ONLY place the 1.0 variant classes live. */
const COMPAT_PACK = read("basecoat-compat.cdn.min.css");

/** Is `name` defined as a class selector anywhere in this stylesheet? */
const defines = (css: string, name: string) =>
  new RegExp(`\\.${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[{,:\\s\\[]`).test(css);

describe("finding 4 — Basecoat 1.0 uses data-variant attributes, not variant classes", () => {
  it("ships no btn-secondary or btn-destructive in either prebuilt pack", () => {
    // THE FACT THAT MADE THE ARCHIVED 6b TEST STALE. The original mapping
    // was `btn` / `btn-secondary` / `btn-destructive`; none of the latter two
    // exist in a bundle the shell would ever load.
    for (const cls of ["btn-secondary", "btn-destructive", "btn-primary"]) {
      expect(defines(DEFAULT_PACK, cls), `${cls} in default pack`).toBe(false);
      expect(defines(BASE_PACK, cls), `${cls} in base pack`).toBe(false);
    }
  });

  it("keeps btn-secondary alive ONLY in the legacy compat stylesheet", () => {
    // The class is not imaginary — it is legacy. That is exactly why the
    // stale assertion looked plausible: it is true of Basecoat 0.x.
    expect(defines(COMPAT_PACK, "btn-secondary")).toBe(true);
  });

  it("ships the data-variant selectors the mapping targets", () => {
    // The converse of the above: what the corrected mapping emits must
    // actually be styled by the bundle.
    expect(DEFAULT_PACK).toContain(".btn[data-variant=secondary]");
    expect(DEFAULT_PACK).toContain(".btn[data-variant=destructive]");
  });

  it("maps the three catalogue variants onto shipped attribute values", () => {
    const declared = shellCatalog.components["Button"]!.props["variant"]!.values!;
    expect([...declared]).toEqual(["primary", "secondary", "danger"]);
    // `primary` is Basecoat's DEFAULT: the attribute is omitted, not set.
    expect(dataVariantFor("Button", "primary")).toBeUndefined();
    expect(dataVariantFor("Button", "secondary")).toBe("secondary");
    expect(dataVariantFor("Button", "danger")).toBe("destructive");
  });
});

describe("finding 5 — the prebuilt bundle contains no Tailwind utilities", () => {
  it("defines the semantic classes the mapping relies on", () => {
    for (const cls of ["btn", "label", "input"]) {
      expect(defines(DEFAULT_PACK, cls), `${cls} missing from default pack`).toBe(true);
    }
  });

  it("defines none of the layout utilities the ORIGINAL 6b mapping used", () => {
    // The archived mapping was `flex flex-col gap-2` / `flex flex-row
    // items-center gap-2` / `grid gap-1.5`. Rendered against the prebuilt
    // bundle those classes style NOTHING — invisible in happy-dom, obvious
    // in a browser, which is how rung 7 found it.
    for (const cls of ["flex", "flex-col", "flex-row", "items-center", "gap-2", "grid"]) {
      expect(defines(DEFAULT_PACK, cls), `${cls} unexpectedly present`).toBe(false);
    }
  });

  it("moves layout onto shell-owned classes instead", () => {
    expect(classesFor("Column")).toBe("shell-col");
    expect(classesFor("Row")).toBe("shell-row");
    expect(classesFor("TextField")).toBe("shell-field");
    // Shell-owned means exactly that: the shell's own stylesheet defines
    // them, so they must NOT be expected from the vendor bundle.
    for (const cls of ["shell-col", "shell-row", "shell-field"]) {
      expect(defines(DEFAULT_PACK, cls)).toBe(false);
    }
  });

  it("records the gap: Text variants are still Tailwind utilities", () => {
    // OPEN HOLE, reported not fixed (lib/ is read-only for this rung).
    // Finding 5 moved LAYOUT off utilities; typography was not moved with
    // it. Every class the Text mapping emits is absent from the bundle the
    // shell is meant to ship, so text variants are currently unstyled on
    // the zero-build path. Distinct classes per variant — which is all the
    // archived test checks — is not the same as styled.
    const textClasses = new Set(
      Object.values(BASECOAT_CLASSES["Text"]!.variants!).flatMap((v) => v.split(/\s+/)),
    );
    for (const cls of textClasses) {
      expect(defines(DEFAULT_PACK, cls), `${cls} is styled after all`).toBe(false);
    }
    // The tag, however, IS meaningful: Basecoat styles bare h1/h2/p.
    expect(textClasses.has("text-2xl")).toBe(true);
  });
});

describe("finding: classes originate in the mapping and never in a message", () => {
  let root: HTMLElement;

  beforeEach(() => {
    document.body.innerHTML = "";
    root = document.createElement("div");
    document.body.appendChild(root);
  });

  const create: A2uiMessage = {
    version: "v0.9.1",
    createSurface: { surfaceId: "dialog", catalogId: shellCatalog.catalogId },
  };

  const render = (components: Record<string, unknown>[]) => {
    const r = createRenderer(root, shellCatalog);
    r.handle(create);
    r.handle({
      version: "v0.9.1",
      updateComponents: {
        surfaceId: "dialog",
        components: components as never,
      },
    });
    return r;
  };

  it("ignores class and className on EVERY styled component, not just Text", () => {
    // The archived file asserts this for Text only. A peer authors the whole
    // tree, so the negative has to hold everywhere a class is written.
    render([
      { id: "root", component: "Column", children: ["r", "b", "f"], class: "evil-col" },
      { id: "r", component: "Row", children: [], className: "evil-row" },
      { id: "b", component: "Button", child: "t", variant: "primary", class: "evil-btn" },
      { id: "t", component: "Text", text: "OK" },
      { id: "f", component: "TextField", label: "Name", className: "evil-field" },
    ]);
    for (const el of Array.from(root.querySelectorAll("*"))) {
      expect(el.className, el.tagName).not.toMatch(/evil/);
    }
  });

  it("does not let a message set data-variant directly", () => {
    // The 1.0 correction moved the variant into an ATTRIBUTE, which opens a
    // second injection path the original mapping did not have. It must be
    // just as closed: only `variant`, validated against the catalogue enum,
    // may reach `data-variant`.
    render([
      {
        id: "root",
        component: "Button",
        child: "t",
        variant: "primary",
        "data-variant": "destructive",
      },
      { id: "t", component: "Text", text: "OK" },
    ]);
    const btn = root.querySelector("button") as HTMLElement;
    expect(btn.getAttribute("data-variant")).toBeNull();
  });

  it("rejects a variant the catalogue does not declare", () => {
    // The enum is the gate. Without it, `variant` would be a free-text
    // attribute value written into the DOM.
    expect(() =>
      render([
        { id: "root", component: "Button", child: "t", variant: "evil" },
        { id: "t", component: "Text", text: "OK" },
      ]),
    ).toThrow(/must be one of/);
  });

  it("emits no class for a component that has no mapping entry", () => {
    // classesFor is total: an unmapped name yields "", never the name
    // itself. A mapping miss must not become a class-name pass-through.
    expect(classesFor("Iframe")).toBe("");
    expect(classesFor("Iframe", "evil")).toBe("");
  });
});
