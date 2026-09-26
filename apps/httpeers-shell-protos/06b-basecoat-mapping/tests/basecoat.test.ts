/**
 * RECOVERED from the prototype 6b archive
 *   `28-prototype-06b-basecoat-mapping/proto6b-basecoat/test/basecoat.test.ts`
 *
 * TWO EDITS, and only two:
 *   1. Imports repointed from the archive's own `../src/*` copies to the
 *      consolidated `../../lib/*` (shell-core). The archive holds a
 *      SUPERSEDED copy of both the renderer and the mapping.
 *   2. ONE test rewritten -- "maps each button variant to a distinct
 *      Basecoat class". It is marked CORRECTED in place and says exactly
 *      what changed and why. Nothing else was touched.
 *
 * Eleven of the twelve recovered tests pass against shell-core unmodified.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { BASECOAT_CLASSES, unmappedComponents } from "../../lib/basecoat.js";
import { shellCatalog } from "../../lib/catalog.js";
import { type A2uiMessage, createRenderer } from "../../lib/renderer.js";

/**
 * PROTOTYPE 6b — can the A2UI catalogue render as Basecoat components?
 *
 * THIS RUNG CAN GENUINELY REJECT. If the six catalogue components cannot be
 * expressed in Basecoat's markup and semantic classes without inventing new
 * ones, the catalogue was designed too abstractly — and that is the finding,
 * not a task to work around.
 *
 * Basecoat is the shadcn/ui design system as Tailwind classes plus semantic
 * names (btn, input, card), with no React and no framework runtime. That is
 * why it was chosen over shadcn/ui itself: the shell is vanilla TypeScript.
 */

let root: HTMLElement;

beforeEach(() => {
  document.body.innerHTML = "";
  root = document.createElement("div");
  document.body.appendChild(root);
});

const CATALOG_ID = shellCatalog.catalogId;
const create: A2uiMessage = {
  version: "v0.9.1",
  createSurface: { surfaceId: "dialog", catalogId: CATALOG_ID },
};

describe("coverage: does every catalogue component have a mapping?", () => {
  it("leaves no component unmapped", () => {
    // THE REJECT TEST. A non-empty list here means the catalogue cannot be
    // expressed in Basecoat as designed.
    expect(unmappedComponents(shellCatalog)).toEqual([]);
  });

  it("requires no component outside the catalogue", () => {
    // The converse: the mapping must not have quietly introduced a seventh
    // component to make the design work.
    const mapped = Object.keys(BASECOAT_CLASSES);
    const declared = Object.keys(shellCatalog.components);
    expect(mapped.sort()).toEqual(declared.sort());
  });
});

describe("semantic classes, not class soup", () => {
  it("gives a button the btn class and a variant modifier", () => {
    const r = createRenderer(root, shellCatalog);
    r.handle(create);
    r.handle({
      version: "v0.9.1",
      updateComponents: {
        surfaceId: "dialog",
        components: [
          { id: "root", component: "Button", child: "l", variant: "primary" },
          { id: "l", component: "Text", text: "OK" },
        ],
      },
    });
    const btn = root.querySelector("button") as HTMLElement;
    expect(btn.className).toContain("btn");
  });

  it("renders each button variant distinguishably", () => {
    // ------------------------------------------------------------------
    // CORRECTED against shell-core. THE ONLY REWRITTEN TEST IN THIS FILE.
    //
    // The archived assertion was, verbatim:
    //
    //     const primary   = classFor("primary");
    //     const secondary = classFor("secondary");
    //     const danger    = classFor("danger");
    //     expect(new Set([primary, secondary, danger]).size).toBe(3);
    //
    // -- three DISTINCT className strings, which encoded the original 6b
    // mapping `btn` / `btn-secondary` / `btn-destructive`. Against
    // shell-core it fails with `expected 1 to be 3`, because rung 7
    // measured that Basecoat 1.0 replaced composed variant CLASSES with
    // `data-variant` ATTRIBUTES. All three variants now carry the SAME
    // class, `btn`, and differ by attribute.
    //
    // STALE TEST, NOT A DEFECT. `btn-secondary` does not exist in the
    // basecoat-css@1.0.2 bundles at all -- only in the optional legacy
    // compat stylesheet -- so the archived assertion asserts a model the
    // shipped library disproves. The evidence is measured against the real
    // package in `basecoat-1.0-corrections.test.ts`.
    //
    // The rung's CLAIM is unchanged and still enforced: the three catalogue
    // variants must render distinguishably. What carries the distinction
    // moved from the class list to an attribute, so the signature does too.
    // ------------------------------------------------------------------
    const r = createRenderer(root, shellCatalog);
    r.handle(create);
    const signatureFor = (variant: string) => {
      r.handle({
        version: "v0.9.1",
        updateComponents: {
          surfaceId: "dialog",
          components: [
            { id: "root", component: "Button", child: "l", variant },
            { id: "l", component: "Text", text: "x" },
          ],
        },
      });
      const btn = root.querySelector("button") as HTMLElement;
      return {
        className: btn.className,
        variant: btn.getAttribute("data-variant"),
      };
    };
    const primary = signatureFor("primary");
    const secondary = signatureFor("secondary");
    const danger = signatureFor("danger");

    // Distinguishable: three different rendered signatures.
    const signatures = [primary, secondary, danger].map((s) => `${s.className}|${s.variant ?? ""}`);
    expect(new Set(signatures).size).toBe(3);

    // ...and the distinction is NOT in the class, which stays constant.
    // Were a future change to reintroduce `btn-secondary`, this fails.
    expect(new Set(signatures.map((_, i) => [primary, secondary, danger][i]!.className))).toEqual(
      new Set(["btn"]),
    );

    // Primary is Basecoat's default: the attribute is omitted, not set.
    expect(primary.variant).toBeNull();
    expect(secondary.variant).toBe("secondary");
    expect(danger.variant).toBe("destructive");
  });

  it("gives a text field the input class", () => {
    const r = createRenderer(root, shellCatalog);
    r.handle(create);
    r.handle({
      version: "v0.9.1",
      updateComponents: {
        surfaceId: "dialog",
        components: [{ id: "root", component: "TextField", label: "Name" }],
      },
    });
    const input = root.querySelector("input") as HTMLElement;
    expect(input.className).toContain("input");
  });

  it("keeps markup readable: no long utility-class strings", () => {
    // The stated reason to use Basecoat over raw Tailwind is avoiding class
    // soup. If the mapping produces walls of utilities, the benefit is lost.
    const r = createRenderer(root, shellCatalog);
    r.handle(create);
    r.handle({
      version: "v0.9.1",
      updateComponents: {
        surfaceId: "dialog",
        components: [
          { id: "root", component: "Button", child: "l", variant: "primary" },
          { id: "l", component: "Text", text: "OK" },
        ],
      },
    });
    const btn = root.querySelector("button") as HTMLElement;
    expect(btn.className.split(/\s+/).filter(Boolean).length).toBeLessThanOrEqual(3);
  });
});

describe("layout components", () => {
  it("renders Row and Column as flex containers with distinct direction", () => {
    const r = createRenderer(root, shellCatalog);
    r.handle(create);
    r.handle({
      version: "v0.9.1",
      updateComponents: {
        surfaceId: "dialog",
        components: [
          { id: "root", component: "Column", children: ["a"] },
          { id: "a", component: "Row", children: ["b"] },
          { id: "b", component: "Text", text: "x" },
        ],
      },
    });
    const col = root.querySelector('[data-layout="column"]') as HTMLElement;
    const row = root.querySelector('[data-layout="row"]') as HTMLElement;
    expect(col.className).not.toBe(row.className);
  });

  it("renders a divider as an hr", () => {
    const r = createRenderer(root, shellCatalog);
    r.handle(create);
    r.handle({
      version: "v0.9.1",
      updateComponents: {
        surfaceId: "dialog",
        components: [{ id: "root", component: "Divider" }],
      },
    });
    expect(root.querySelector("hr")).not.toBeNull();
  });
});

describe("text variants map to Basecoat typography", () => {
  it("uses distinct classes per variant", () => {
    const r = createRenderer(root, shellCatalog);
    r.handle(create);
    const classFor = (variant?: string) => {
      r.handle({
        version: "v0.9.1",
        updateComponents: {
          surfaceId: "dialog",
          components: [
            { id: "root", component: "Text", text: "x", ...(variant ? { variant } : {}) },
          ],
        },
      });
      return (root.querySelector("[data-component='Text']") as HTMLElement).className;
    };
    expect(classFor("h1")).not.toBe(classFor("body"));
  });
});

describe("styling does not weaken the rung 2 and 3 guarantees", () => {
  it("still refuses markup in text", () => {
    const r = createRenderer(root, shellCatalog);
    r.handle(create);
    r.handle({
      version: "v0.9.1",
      updateComponents: {
        surfaceId: "dialog",
        components: [{ id: "root", component: "Text", text: "<img src=x onerror=alert(1)>" }],
      },
    });
    expect(root.querySelector("img")).toBeNull();
  });

  it("does not let a surface inject arbitrary classes", () => {
    // A peer must not be able to smuggle a class name through a prop and
    // restyle the shell. Classes come from the MAPPING, never from the
    // message.
    const r = createRenderer(root, shellCatalog);
    r.handle(create);
    r.handle({
      version: "v0.9.1",
      updateComponents: {
        surfaceId: "dialog",
        components: [
          {
            id: "root",
            component: "Text",
            text: "x",
            class: "fixed inset-0 z-50 bg-red-500",
            className: "evil",
          },
        ],
      },
    });
    const el = root.querySelector("[data-component='Text']") as HTMLElement;
    expect(el.className).not.toContain("evil");
    expect(el.className).not.toContain("fixed");
  });

  it("still rejects components outside the catalogue", () => {
    const r = createRenderer(root, shellCatalog);
    r.handle(create);
    expect(() =>
      r.handle({
        version: "v0.9.1",
        updateComponents: {
          surfaceId: "dialog",
          components: [{ id: "root", component: "Iframe", src: "x" }],
        },
      }),
    ).toThrow(/not in catalogue/);
  });
});
