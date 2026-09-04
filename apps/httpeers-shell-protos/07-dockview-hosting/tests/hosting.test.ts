// DERIVED-FROM-NOTE: 31 §2 (the join is cleaner than expected — but not as documented)
// DERIVED-FROM-NOTE: 31 §1 (does Dockview host A2UI surfaces, one per pane?)
// DERIVED-FROM-NOTE: 32 §3 (first open replays messages; restore does not)
// DERIVED-FROM-NOTE: ORIGIN.md finding 6 (IContentRenderer must own its element)
//
// Rung 7: does Dockview host one A2UI surface per pane, and on what contract?

import { beforeEach, describe, expect, it } from "vitest";
import { DockviewComponent, themeLight } from "dockview-core";
import { createShellDock, type PaneSpec } from "../../lib/dock.js";
import { shellCatalog } from "../../lib/catalog.js";
import type { A2uiMessage } from "../../lib/renderer.js";

/** A minimal surface: one root Text node carrying a recognisable string. */
function surfaceMessages(surfaceId: string, text: string): A2uiMessage[] {
  return [
    { version: "v0.9.1", createSurface: { surfaceId, catalogId: shellCatalog.catalogId } },
    {
      version: "v0.9.1",
      updateComponents: {
        surfaceId,
        components: [{ id: "root", component: "Text", text }],
      },
    },
  ];
}

function newHost(): HTMLElement {
  const host = document.createElement("div");
  document.body.appendChild(host);
  return host;
}

beforeEach(() => {
  document.body.replaceChildren();
  document.head.replaceChildren();
});

describe("the IContentRenderer contract (rung 7's expensive finding)", () => {
  it("hands init NO container element — the documented params.containerElement does not exist", () => {
    // Note 31 §2: the published examples show `init(params)` receiving
    // `params.containerElement`. The first attempt against v8 failed with
    // "Cannot read properties of undefined (reading 'appendChild')".
    //
    // This asserts against the params Dockview ACTUALLY passes, so it is a
    // statement about dockview-core 8.2.0 rather than a restatement of the
    // note.
    let seen: Record<string, unknown> | undefined;
    const dockview = new DockviewComponent(newHost(), {
      theme: themeLight,
      createComponent: () => {
        const element = document.createElement("div");
        return {
          element,
          init: (params: Record<string, unknown>) => {
            seen = params;
          },
        };
      },
    });
    dockview.addPanel({ id: "p", component: "surface" });

    expect(seen).toBeDefined();
    expect(Object.keys(seen as object).sort()).toEqual([
      "api",
      "containerApi",
      "params",
      "title",
    ]);
    expect("containerElement" in (seen as object)).toBe(false);
  });

  it("mounts the element the component OWNS, into its own content container", () => {
    let owned: HTMLElement | undefined;
    const host = newHost();
    const dockview = new DockviewComponent(host, {
      theme: themeLight,
      createComponent: () => {
        const element = document.createElement("div");
        element.setAttribute("data-owned", "yes");
        owned = element;
        return { element, init: () => undefined };
      },
    });
    dockview.addPanel({ id: "p", component: "surface" });

    const element = owned as unknown as HTMLElement;
    expect(element.isConnected).toBe(true);
    expect(host.contains(element)).toBe(true);
    // Mounted by Dockview into its own container: the SAME instance, not a copy.
    expect(element.parentElement?.classList.contains("dv-content-container")).toBe(true);
    expect(host.querySelector("[data-owned]")).toBe(element);
  });

  it("rejects a component that does not own an element", () => {
    // The browser reported "Cannot read properties of undefined (reading
    // 'appendChild')" (note 31 §2); happy-dom's proxying reports a different
    // message for the same missing property, so the assertion is that the
    // shape is rejected, not that the wording matches.
    const dockview = new DockviewComponent(newHost(), {
      theme: themeLight,
      createComponent: () => ({ init: () => undefined }) as never,
    });
    expect(() => dockview.addPanel({ id: "p", component: "surface" })).toThrow();
  });
});

describe("one surface per pane", () => {
  const specs: PaneSpec[] = [
    { id: "notes", title: "Notes", origin: "https://notes.example/", messages: surfaceMessages("notes", "NOTES-CONTENT") },
    {
      id: "sql",
      title: "SQL Console",
      origin: "https://sql.example/",
      messages: surfaceMessages("sql", "SQL-CONTENT"),
      position: { referencePanel: "notes", direction: "right" },
    },
  ];

  it("gives each pane its own renderer and its own data model", () => {
    const dock = createShellDock(newHost());
    for (const spec of specs) dock.addPane(spec);

    expect(dock.paneIds()).toEqual(["notes", "sql"]);
    expect([...dock.renderers.keys()].sort()).toEqual(["notes", "sql"]);
    expect(dock.renderers.get("notes")).not.toBe(dock.renderers.get("sql"));

    // Data models are separate: writing one does not appear in the other.
    dock.renderers.get("notes")?.handle({
      version: "v0.9.1",
      updateDataModel: { surfaceId: "notes", path: "/query", value: "select 1" },
    });
    expect(dock.renderers.get("notes")?.dataModel("notes")).toEqual({ query: "select 1" });
    expect(dock.renderers.get("sql")?.dataModel("notes")).toBeUndefined();
    expect(dock.renderers.get("sql")?.surfaces()).toEqual(["sql"]);
  });

  it("replays the spec's messages on first open, into that pane's own element", () => {
    const host = newHost();
    const dock = createShellDock(host);
    for (const spec of specs) dock.addPane(spec);

    const containers = [...host.querySelectorAll(".dv-content-container")];
    expect(containers).toHaveLength(2);

    const texts = containers.map((c) => c.textContent);
    expect(texts).toContain("NOTES-CONTENT");
    expect(texts).toContain("SQL-CONTENT");
    // Content does not bleed between panes.
    for (const container of containers) {
      const both =
        container.textContent?.includes("NOTES-CONTENT") &&
        container.textContent?.includes("SQL-CONTENT");
      expect(both).toBeFalsy();
    }
  });

  it("records the origin a pane was served from", () => {
    const dock = createShellDock(newHost());
    for (const spec of specs) dock.addPane(spec);
    expect(dock.originOf("notes")).toBe("https://notes.example/");
    expect(dock.originOf("sql")).toBe("https://sql.example/");
    expect(dock.originOf("never-opened")).toBeUndefined();
  });

  it("serialises a layout — the artefact rung 7a then round-trips", () => {
    const dock = createShellDock(newHost());
    for (const spec of specs) dock.addPane(spec);
    const layout = dock.toJSON() as Record<string, unknown>;
    expect(Object.keys(layout)).toContain("grid");
    expect(Object.keys(layout)).toContain("panels");
  });
});
