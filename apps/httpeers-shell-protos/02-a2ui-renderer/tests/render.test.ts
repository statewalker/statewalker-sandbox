// RECOVERED from 19-prototype-02-a2ui-renderer.tar.gz
// (proto2-a2ui-render/test/render.test.ts, 16 tests). The only edits are the
// two import paths, rewritten from the archive's own `../src/` to the
// consolidated `../../lib/`, and ONE assertion in "renders a button with its
// label child" that the consolidated renderer deliberately falsified -- see
// the comment at its site and README.md.
import { beforeEach, describe, expect, it } from "vitest";
import { shellCatalog } from "../../lib/catalog.js";
import { createRenderer, type A2uiMessage } from "../../lib/renderer.js";

/**
 * PROTOTYPE 2 — can a JSON spec render into one DOM root against a
 * catalogue?
 *
 * SCOPE. Static structure only. No data binding, no action dispatch, no
 * second surface — those are rung 3 and later. The question here is
 * narrowly whether the adjacency-list model renders correctly and whether
 * the catalogue actually constrains what an agent may send.
 *
 * Message shapes follow A2UI v0.9.1 as documented at a2ui.org:
 * createSurface / updateComponents, components as a flat list with
 * `id` and `component` fields, containers referencing children by id.
 */

let root: HTMLElement;

beforeEach(() => {
  document.body.innerHTML = "";
  root = document.createElement("div");
  document.body.appendChild(root);
});

const create: A2uiMessage = {
  version: "v0.9.1",
  createSurface: {
    surfaceId: "dialog",
    catalogId: "https://httpeers.dev/catalogs/shell/v1/catalog.json",
  },
};

describe("surface lifecycle", () => {
  it("renders nothing until components arrive", () => {
    const r = createRenderer(root, shellCatalog);
    r.handle(create);
    expect(root.textContent).toBe("");
  });

  it("renders a single text component at the root", () => {
    const r = createRenderer(root, shellCatalog);
    r.handle(create);
    r.handle({
      version: "v0.9.1",
      updateComponents: {
        surfaceId: "dialog",
        components: [{ id: "root", component: "Text", text: "Hello" }],
      },
    });
    expect(root.textContent).toBe("Hello");
  });

  it("rejects components for an unknown surface", () => {
    const r = createRenderer(root, shellCatalog);
    expect(() =>
      r.handle({
        version: "v0.9.1",
        updateComponents: {
          surfaceId: "nope",
          components: [{ id: "root", component: "Text", text: "x" }],
        },
      }),
    ).toThrow(/Unknown surface/);
  });

  it("removes the surface on deleteSurface", () => {
    const r = createRenderer(root, shellCatalog);
    r.handle(create);
    r.handle({
      version: "v0.9.1",
      updateComponents: {
        surfaceId: "dialog",
        components: [{ id: "root", component: "Text", text: "Hello" }],
      },
    });
    r.handle({ version: "v0.9.1", deleteSurface: { surfaceId: "dialog" } });
    expect(root.textContent).toBe("");
  });
});

describe("adjacency list model", () => {
  it("builds a tree from id references", () => {
    const r = createRenderer(root, shellCatalog);
    r.handle(create);
    r.handle({
      version: "v0.9.1",
      updateComponents: {
        surfaceId: "dialog",
        components: [
          { id: "root", component: "Column", children: ["title", "body"] },
          { id: "title", component: "Text", text: "Confirm", variant: "h1" },
          { id: "body", component: "Text", text: "Are you sure?" },
        ],
      },
    });
    expect(root.querySelector("h1")?.textContent).toBe("Confirm");
    expect(root.textContent).toContain("Are you sure?");
  });

  it("accepts components in ANY order, children before parents", () => {
    // The spec is explicit that order does not matter as long as every
    // referenced component is present when rendering is triggered.
    const r = createRenderer(root, shellCatalog);
    r.handle(create);
    r.handle({
      version: "v0.9.1",
      updateComponents: {
        surfaceId: "dialog",
        components: [
          { id: "leaf", component: "Text", text: "deep" },
          { id: "mid", component: "Column", children: ["leaf"] },
          { id: "root", component: "Column", children: ["mid"] },
        ],
      },
    });
    expect(root.textContent).toBe("deep");
  });

  it("updates incrementally without re-sending the whole tree", () => {
    const r = createRenderer(root, shellCatalog);
    r.handle(create);
    r.handle({
      version: "v0.9.1",
      updateComponents: {
        surfaceId: "dialog",
        components: [
          { id: "root", component: "Column", children: ["a", "b"] },
          { id: "a", component: "Text", text: "first" },
          { id: "b", component: "Text", text: "second" },
        ],
      },
    });
    // Replace only one component by id.
    r.handle({
      version: "v0.9.1",
      updateComponents: {
        surfaceId: "dialog",
        components: [{ id: "b", component: "Text", text: "CHANGED" }],
      },
    });
    expect(root.textContent).toContain("first");
    expect(root.textContent).toContain("CHANGED");
    expect(root.textContent).not.toContain("second");
  });

  it("reports a dangling child reference rather than rendering a hole", () => {
    const r = createRenderer(root, shellCatalog);
    r.handle(create);
    expect(() =>
      r.handle({
        version: "v0.9.1",
        updateComponents: {
          surfaceId: "dialog",
          components: [{ id: "root", component: "Column", children: ["missing"] }],
        },
      }),
    ).toThrow(/missing/);
  });

  it("detects a reference cycle instead of recursing forever", () => {
    const r = createRenderer(root, shellCatalog);
    r.handle(create);
    expect(() =>
      r.handle({
        version: "v0.9.1",
        updateComponents: {
          surfaceId: "dialog",
          components: [
            { id: "root", component: "Column", children: ["loop"] },
            { id: "loop", component: "Column", children: ["root"] },
          ],
        },
      }),
    ).toThrow(/[Cc]ycle/);
  });
});

describe("the catalogue constrains what may be rendered", () => {
  it("rejects a component type not in the catalogue", () => {
    const r = createRenderer(root, shellCatalog);
    r.handle(create);
    expect(() =>
      r.handle({
        version: "v0.9.1",
        updateComponents: {
          surfaceId: "dialog",
          components: [{ id: "root", component: "ScriptTag", src: "evil.js" }],
        },
      }),
    ).toThrow(/not in catalogue/);
  });

  it("rejects a component missing a required property", () => {
    const r = createRenderer(root, shellCatalog);
    r.handle(create);
    expect(() =>
      r.handle({
        version: "v0.9.1",
        updateComponents: {
          surfaceId: "dialog",
          components: [{ id: "root", component: "Text" }],
        },
      }),
    ).toThrow(/text/);
  });

  it("rejects a catalogId the renderer does not implement", () => {
    const r = createRenderer(root, shellCatalog);
    expect(() =>
      r.handle({
        version: "v0.9.1",
        createSurface: { surfaceId: "x", catalogId: "https://elsewhere/other.json" },
      }),
    ).toThrow(/catalog/i);
  });

  it("never injects markup from component text", () => {
    // Text arrives from a foreign peer. It must be text, never HTML.
    const r = createRenderer(root, shellCatalog);
    r.handle(create);
    r.handle({
      version: "v0.9.1",
      updateComponents: {
        surfaceId: "dialog",
        components: [
          { id: "root", component: "Text", text: "<img src=x onerror=alert(1)>" },
        ],
      },
    });
    expect(root.querySelector("img")).toBeNull();
    expect(root.textContent).toContain("<img");
  });
});

describe("shell components", () => {
  it("renders a button with its label child", () => {
    const r = createRenderer(root, shellCatalog);
    r.handle(create);
    r.handle({
      version: "v0.9.1",
      updateComponents: {
        surfaceId: "dialog",
        components: [
          { id: "root", component: "Button", child: "lbl", variant: "primary",
            action: { event: { name: "confirm" } } },
          { id: "lbl", component: "Text", text: "OK" },
        ],
      },
    });
    const btn = root.querySelector("button");
    expect(btn?.textContent).toBe("OK");

    // ---- STALE ARCHIVE ASSERTION, CORRECTED ----------------------------
    // The archive asserted `data-variant === "primary"`, and against rung 2's
    // own renderer it passed: that renderer echoed the message's variant
    // string straight onto the element --
    //     if (c["variant"]) el.setAttribute("data-variant", String(c["variant"]))
    // Rung 7 measured that Basecoat 1.0's bare `.btn` IS the primary button
    // and `data-variant` selects only a NON-default variant, so lib/basecoat.ts
    // maps primary -> undefined, i.e. OMIT the attribute (note 32 §1).
    // This assertion therefore encodes a model rung 7 disproved. It is stale,
    // not a defect in lib/ -- the same class of drift consolidation caught in
    // the 6b copy. Corrected here to the live contract; see README.md.
    expect(btn?.className).toBe("btn");
    expect(btn?.hasAttribute("data-variant")).toBe(false);
  });

  it("renders a row, a divider and a text field", () => {
    const r = createRenderer(root, shellCatalog);
    r.handle(create);
    r.handle({
      version: "v0.9.1",
      updateComponents: {
        surfaceId: "dialog",
        components: [
          { id: "root", component: "Row", children: ["f", "d"] },
          { id: "f", component: "TextField", label: "Name" },
          { id: "d", component: "Divider" },
        ],
      },
    });
    expect(root.querySelector("input")).not.toBeNull();
    expect(root.querySelector("hr")).not.toBeNull();
  });

  it("exposes the catalogue as a JSON Schema document", () => {
    // The catalogue is data, not code: it must be serialisable so it can be
    // published at its catalogId URI and negotiated with a peer.
    expect(() => JSON.stringify(shellCatalog)).not.toThrow();
    expect(shellCatalog.catalogId).toMatch(/^https:\/\//);
    expect(Object.keys(shellCatalog.components)).toContain("Text");
  });
});
