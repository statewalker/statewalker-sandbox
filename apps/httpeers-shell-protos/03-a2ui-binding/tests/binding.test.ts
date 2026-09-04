import { beforeEach, describe, expect, it, vi } from "vitest";
import { shellCatalog } from "../../lib/catalog.js";
import { createRenderer, type A2uiMessage } from "../../lib/renderer.js";

/**
 * PROTOTYPE 3 — do data binding and action dispatch round-trip?
 *
 * Rung 2 proved static structure renders. This rung asks whether the
 * surface can be made INTERACTIVE without re-sending the tree, and whether
 * user actions travel back out.
 *
 * It also has to solve a problem rung 2 created: full repaint on every
 * update destroys focus and caret position, which is fine for static text
 * and fatal for a bound TextField.
 */

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

describe("data binding", () => {
  it("renders a bound value from the data model", () => {
    const r = createRenderer(root, shellCatalog);
    r.handle(create);
    r.handle({
      version: "v0.9.1",
      updateDataModel: { surfaceId: "dialog", path: "/user", value: { name: "Ada" } },
    });
    r.handle({
      version: "v0.9.1",
      updateComponents: {
        surfaceId: "dialog",
        components: [{ id: "root", component: "Text", text: { path: "/user/name" } }],
      },
    });
    expect(root.textContent).toBe("Ada");
  });

  it("updates a bound component WITHOUT re-sending the component tree", () => {
    const r = createRenderer(root, shellCatalog);
    r.handle(create);
    r.handle({
      version: "v0.9.1",
      updateComponents: {
        surfaceId: "dialog",
        components: [{ id: "root", component: "Text", text: { path: "/count" } }],
      },
    });
    r.handle({ version: "v0.9.1", updateDataModel: { surfaceId: "dialog", path: "/count", value: "1" } });
    expect(root.textContent).toBe("1");

    // Only the data model changes. No updateComponents.
    r.handle({ version: "v0.9.1", updateDataModel: { surfaceId: "dialog", path: "/count", value: "2" } });
    expect(root.textContent).toBe("2");
  });

  it("renders an empty string for an unresolved path rather than throwing", () => {
    const r = createRenderer(root, shellCatalog);
    r.handle(create);
    r.handle({
      version: "v0.9.1",
      updateComponents: {
        surfaceId: "dialog",
        components: [{ id: "root", component: "Text", text: { path: "/nothing/here" } }],
      },
    });
    expect(root.textContent).toBe("");
  });

  it("writes a nested path without clobbering siblings", () => {
    const r = createRenderer(root, shellCatalog);
    r.handle(create);
    r.handle({
      version: "v0.9.1",
      updateDataModel: { surfaceId: "dialog", path: "/f", value: { a: "1", b: "2" } },
    });
    r.handle({ version: "v0.9.1", updateDataModel: { surfaceId: "dialog", path: "/f/a", value: "CHANGED" } });
    r.handle({
      version: "v0.9.1",
      updateComponents: {
        surfaceId: "dialog",
        components: [
          { id: "root", component: "Row", children: ["x", "y"] },
          { id: "x", component: "Text", text: { path: "/f/a" } },
          { id: "y", component: "Text", text: { path: "/f/b" } },
        ],
      },
    });
    expect(root.textContent).toContain("CHANGED");
    expect(root.textContent).toContain("2");
  });

  it("keeps data models separate per surface", () => {
    const r = createRenderer(root, shellCatalog);
    r.handle(create);
    r.handle({ version: "v0.9.1", createSurface: { surfaceId: "other", catalogId: CATALOG_ID } });
    r.handle({ version: "v0.9.1", updateDataModel: { surfaceId: "dialog", path: "/v", value: "A" } });
    r.handle({ version: "v0.9.1", updateDataModel: { surfaceId: "other", path: "/v", value: "B" } });
    expect(r.dataModel("dialog")).toMatchObject({ v: "A" });
    expect(r.dataModel("other")).toMatchObject({ v: "B" });
  });
});

describe("focus preservation", () => {
  it("does NOT lose focus when an unrelated bound value changes", () => {
    // The problem rung 2 created. A naive full repaint destroys the element
    // the user is typing into.
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

    const input = root.querySelector("input") as HTMLInputElement;
    input.focus();
    input.value = "partial";
    input.setSelectionRange(3, 3);
    expect(document.activeElement).toBe(input);

    r.handle({ version: "v0.9.1", updateDataModel: { surfaceId: "dialog", path: "/status", value: "saving" } });

    expect(root.textContent).toContain("saving");
    // SAME element instance, still focused, caret intact.
    expect(root.querySelector("input")).toBe(input);
    expect(document.activeElement).toBe(input);
    expect(input.selectionStart).toBe(3);
  });

  it("does not overwrite the value of the field being edited", () => {
    const r = createRenderer(root, shellCatalog);
    r.handle(create);
    r.handle({
      version: "v0.9.1",
      updateComponents: {
        surfaceId: "dialog",
        components: [{ id: "root", component: "TextField", value: { path: "/name" } }],
      },
    });
    const input = root.querySelector("input") as HTMLInputElement;
    input.focus();
    input.value = "typing";
    r.handle({ version: "v0.9.1", updateDataModel: { surfaceId: "dialog", path: "/other", value: "x" } });
    expect(input.value).toBe("typing");
  });
});

describe("action dispatch", () => {
  it("emits the action name and surface when a button is clicked", () => {
    const onAction = vi.fn();
    const r = createRenderer(root, shellCatalog, { onAction });
    r.handle(create);
    r.handle({
      version: "v0.9.1",
      updateComponents: {
        surfaceId: "dialog",
        components: [
          { id: "root", component: "Button", child: "lbl", action: { event: { name: "confirm" } } },
          { id: "lbl", component: "Text", text: "OK" },
        ],
      },
    });
    (root.querySelector("button") as HTMLButtonElement).click();
    expect(onAction).toHaveBeenCalledWith(
      expect.objectContaining({ surfaceId: "dialog", name: "confirm" }),
    );
  });

  it("includes the declared context with the action", () => {
    const onAction = vi.fn();
    const r = createRenderer(root, shellCatalog, { onAction });
    r.handle(create);
    r.handle({
      version: "v0.9.1",
      updateComponents: {
        surfaceId: "dialog",
        components: [
          { id: "root", component: "Button", child: "l",
            action: { event: { name: "delete", context: { id: "note-7" } } } },
          { id: "l", component: "Text", text: "Delete" },
        ],
      },
    });
    (root.querySelector("button") as HTMLButtonElement).click();
    expect(onAction).toHaveBeenCalledWith(
      expect.objectContaining({ name: "delete", context: { id: "note-7" } }),
    );
  });

  it("sends the current data model with the action", () => {
    const onAction = vi.fn();
    const r = createRenderer(root, shellCatalog, { onAction });
    r.handle(create);
    r.handle({ version: "v0.9.1", updateDataModel: { surfaceId: "dialog", path: "/name", value: "Ada" } });
    r.handle({
      version: "v0.9.1",
      updateComponents: {
        surfaceId: "dialog",
        components: [
          { id: "root", component: "Button", child: "l", action: { event: { name: "submit" } } },
          { id: "l", component: "Text", text: "Go" },
        ],
      },
    });
    (root.querySelector("button") as HTMLButtonElement).click();
    expect(onAction.mock.calls[0]?.[0].dataModel).toMatchObject({ name: "Ada" });
  });

  it("does not dispatch for a button with no action", () => {
    const onAction = vi.fn();
    const r = createRenderer(root, shellCatalog, { onAction });
    r.handle(create);
    r.handle({
      version: "v0.9.1",
      updateComponents: {
        surfaceId: "dialog",
        components: [
          { id: "root", component: "Button", child: "l" },
          { id: "l", component: "Text", text: "Inert" },
        ],
      },
    });
    (root.querySelector("button") as HTMLButtonElement).click();
    expect(onAction).not.toHaveBeenCalled();
  });

  it("survives a throwing handler without breaking the surface", () => {
    const onAction = vi.fn(() => {
      throw new Error("handler exploded");
    });
    const r = createRenderer(root, shellCatalog, { onAction });
    r.handle(create);
    r.handle({
      version: "v0.9.1",
      updateComponents: {
        surfaceId: "dialog",
        components: [
          { id: "root", component: "Button", child: "l", action: { event: { name: "boom" } } },
          { id: "l", component: "Text", text: "Boom" },
        ],
      },
    });
    expect(() => (root.querySelector("button") as HTMLButtonElement).click()).not.toThrow();
    // surface still updates afterwards
    r.handle({ version: "v0.9.1", updateDataModel: { surfaceId: "dialog", path: "/x", value: "1" } });
    expect(r.dataModel("dialog")).toMatchObject({ x: "1" });
  });
});

describe("client to server data flow", () => {
  it("writes user input back into the data model on change", () => {
    const r = createRenderer(root, shellCatalog);
    r.handle(create);
    r.handle({
      version: "v0.9.1",
      updateComponents: {
        surfaceId: "dialog",
        components: [{ id: "root", component: "TextField", value: { path: "/name" } }],
      },
    });
    const input = root.querySelector("input") as HTMLInputElement;
    input.value = "Grace";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(r.dataModel("dialog")).toMatchObject({ name: "Grace" });
  });

  it("notifies the host when the data model changes from user input", () => {
    const onDataModelChange = vi.fn();
    const r = createRenderer(root, shellCatalog, { onDataModelChange });
    r.handle(create);
    r.handle({
      version: "v0.9.1",
      updateComponents: {
        surfaceId: "dialog",
        components: [{ id: "root", component: "TextField", value: { path: "/name" } }],
      },
    });
    const input = root.querySelector("input") as HTMLInputElement;
    input.value = "Grace";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(onDataModelChange).toHaveBeenCalledWith(
      expect.objectContaining({ surfaceId: "dialog", path: "/name", value: "Grace" }),
    );
  });

  it("does not notify the host for server-originated model updates", () => {
    // Otherwise a server update would echo straight back, looping.
    const onDataModelChange = vi.fn();
    const r = createRenderer(root, shellCatalog, { onDataModelChange });
    r.handle(create);
    r.handle({ version: "v0.9.1", updateDataModel: { surfaceId: "dialog", path: "/name", value: "Ada" } });
    expect(onDataModelChange).not.toHaveBeenCalled();
  });
});

describe("still honours rung 2 guarantees", () => {
  it("does not treat a bound value as markup", () => {
    const r = createRenderer(root, shellCatalog);
    r.handle(create);
    r.handle({
      version: "v0.9.1",
      updateDataModel: {
        surfaceId: "dialog",
        path: "/evil",
        value: "<img src=x onerror=alert(1)>",
      },
    });
    r.handle({
      version: "v0.9.1",
      updateComponents: {
        surfaceId: "dialog",
        components: [{ id: "root", component: "Text", text: { path: "/evil" } }],
      },
    });
    expect(root.querySelector("img")).toBeNull();
    expect(root.textContent).toContain("<img");
  });

  it("still rejects components outside the catalogue", () => {
    const r = createRenderer(root, shellCatalog);
    r.handle(create);
    expect(() =>
      r.handle({
        version: "v0.9.1",
        updateComponents: {
          surfaceId: "dialog",
          components: [{ id: "root", component: "Script", src: "x" }],
        },
      }),
    ).toThrow(/not in catalogue/);
  });
});
