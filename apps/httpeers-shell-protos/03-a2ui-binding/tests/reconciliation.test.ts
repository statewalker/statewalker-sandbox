// RECONSTRUCTED. Not recovered from an archive: these assertions were written
// from the notes, for two claims the recovered `binding.test.ts` states in
// prose but never asserts. Each carries its DERIVED-FROM-NOTE marker.
import { beforeEach, describe, expect, it } from "vitest";
import { shellCatalog } from "../../lib/catalog.js";
import { type A2uiMessage, createRenderer } from "../../lib/renderer.js";

let root: HTMLElement;

beforeEach(() => {
  document.body.innerHTML = "";
  root = document.createElement("div");
  document.body.appendChild(root);
});

const CATALOG_ID = "https://httpeers.dev/catalogs/shell/v1/catalog.json";

const create: A2uiMessage = {
  version: "v0.9.1",
  createSurface: { surfaceId: "dialog", catalogId: CATALOG_ID },
};

describe("the DOM fact behind reconciliation rule 1", () => {
  // DERIVED-FROM-NOTE: 22-Prototype 3: Data Binding and Action Dispatch
  // §3 "The finding: replaceChildren blurs"
  //
  // The rung's expensive finding is a claim about the PLATFORM, not about the
  // renderer: element identity is preserved, the node stays connected, and the
  // element is still blurred. binding.test.ts asserts only the consequence
  // (focus survives an update). If the platform ever stopped blurring here,
  // rule 1 would become dead weight and nothing would say so.
  it("replaceChildren blurs even when passed the SAME element instances", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const input = document.createElement("input");
    host.appendChild(input);
    input.focus();
    expect(document.activeElement).toBe(input);

    host.replaceChildren(input); // identical instance, same order, no change

    expect(host.firstChild).toBe(input); // identity preserved
    expect(input.isConnected).toBe(true); // still in the document
    expect(document.activeElement).not.toBe(input); // and yet: blurred
  });

  // DERIVED-FROM-NOTE: 22-Prototype 3 §3 / 24-Prototypes 2, 3 and 8 API
  // Reference §"Reconciliation contract" rule 1.
  //
  // The renderer's side of the same claim: an update that leaves a container's
  // child list identical must not touch the container's children at all.
  it("does not call replaceChildren when the child list is unchanged", () => {
    const r = createRenderer(root, shellCatalog);
    r.handle(create);
    r.handle({
      version: "v0.9.1",
      updateComponents: {
        surfaceId: "dialog",
        components: [
          { id: "root", component: "Column", children: ["status", "field"] },
          { id: "status", component: "Text", text: { path: "/status" } },
          { id: "field", component: "TextField", label: "Name", value: { path: "/name" } },
        ],
      },
    });

    const column = root.querySelector("[data-layout='column']") as HTMLElement;
    const calls: number[] = [];
    const real = column.replaceChildren.bind(column);
    column.replaceChildren = (...nodes: (Node | string)[]) => {
      calls.push(nodes.length);
      real(...nodes);
    };

    r.handle({
      version: "v0.9.1",
      updateDataModel: { surfaceId: "dialog", path: "/status", value: "saving" },
    });

    expect(root.textContent).toContain("saving"); // the update did land
    expect(calls).toEqual([]); // but the children were never re-set
  });
});

describe("the render key", () => {
  // DERIVED-FROM-NOTE: 29-Prototypes Z, 6a and 6b §"A bug found in the rung 3
  // renderer" -- "The fix is a render key that includes any property affecting
  // element identity, not just the component name."
  //
  // This directly falsifies note 24's "Reconciliation contract", which still
  // says "An element is rebuilt only when the component type at that id
  // changes". Text's variant selects the TAG, so type alone is not enough.
  it("rebuilds when a property that selects the tag changes at the same id", () => {
    const r = createRenderer(root, shellCatalog);
    r.handle(create);
    r.handle({
      version: "v0.9.1",
      updateComponents: {
        surfaceId: "dialog",
        components: [{ id: "root", component: "Text", text: "Title", variant: "body" }],
      },
    });
    const before = root.querySelector("[data-component='Text']") as HTMLElement;
    expect(before.tagName).toBe("P");

    // Same id, same component type, different variant.
    r.handle({
      version: "v0.9.1",
      updateComponents: {
        surfaceId: "dialog",
        components: [{ id: "root", component: "Text", text: "Title", variant: "h1" }],
      },
    });

    const after = root.querySelector("[data-component='Text']") as HTMLElement;
    expect(after.tagName).toBe("H1"); // the tag actually changed
    expect(after).not.toBe(before); // which requires a REBUILD, not a restyle
    expect(after.textContent).toBe("Title");
    expect(root.querySelector("p")).toBeNull(); // no stale element left behind
  });

  it("reuses the element when nothing that affects identity changed", () => {
    // The other half of the key: it must not be so coarse that every update
    // rebuilds, or rule 1 and rule 2 both stop protecting anything.
    const r = createRenderer(root, shellCatalog);
    r.handle(create);
    r.handle({
      version: "v0.9.1",
      updateComponents: {
        surfaceId: "dialog",
        components: [{ id: "root", component: "Text", text: "one", variant: "h2" }],
      },
    });
    const before = root.querySelector("[data-component='Text']") as HTMLElement;
    r.handle({
      version: "v0.9.1",
      updateComponents: {
        surfaceId: "dialog",
        components: [{ id: "root", component: "Text", text: "two", variant: "h2" }],
      },
    });
    const after = root.querySelector("[data-component='Text']") as HTMLElement;
    expect(after).toBe(before);
    expect(after.textContent).toBe("two");
  });
});
