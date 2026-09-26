// DERIVED-FROM-NOTE: 32 §2 (does a layout round-trip preserve surface identity?)
// DERIVED-FROM-NOTE: 32 §3 (identity persists, content does not)
// DERIVED-FROM-NOTE: 32 §4 (a test that passed for the wrong reason — assert
//                            against the artefact that crosses the boundary)
// DERIVED-FROM-NOTE: 32 §5 (PaneParams.origin is optional because a layout
//                            could be hand-edited or come from an older version)
// DERIVED-FROM-NOTE: 32 §7 (open thread: titles are not carried by params)
// DERIVED-FROM-NOTE: ORIGIN.md finding 8 (identity persists, content does not)
//
// Rung 7a: after a restore, can each pane be reassociated with the peer that
// served it?

import { beforeEach, describe, expect, it } from "vitest";
import { shellCatalog } from "../../lib/catalog.js";
import { createShellDock, type PaneSpec, type ShellDock } from "../../lib/dock.js";
import type { A2uiMessage } from "../../lib/renderer.js";

const NOTES_TEXT = "MINUTES-OF-THE-MEETING";
const SQL_TEXT = "SELECT-STAR-FROM-LEDGER";

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
    {
      version: "v0.9.1",
      updateDataModel: { surfaceId, path: "/draft", value: "UNSENT-DRAFT-VALUE" },
    },
  ];
}

const SPECS: PaneSpec[] = [
  {
    id: "notes",
    title: "Notes",
    origin: "https://notes.example/app",
    messages: surfaceMessages("notes", NOTES_TEXT),
  },
  {
    id: "sql",
    title: "SQL Console",
    origin: "https://sql.example/console",
    messages: surfaceMessages("sql", SQL_TEXT),
    position: { referencePanel: "notes", direction: "right" },
  },
];

function newHost(): HTMLElement {
  const host = document.createElement("div");
  document.body.appendChild(host);
  return host;
}

/** A populated dock, with its content genuinely rendered. */
function openedDock(): { host: HTMLElement; dock: ShellDock } {
  const host = newHost();
  const dock = createShellDock(host);
  for (const spec of SPECS) dock.addPane(spec);
  return { host, dock };
}

interface SerialisedLayout {
  readonly panels: Record<string, { params?: Record<string, unknown>; title?: string }>;
}

beforeEach(() => {
  document.body.replaceChildren();
  document.head.replaceChildren();
});

describe("what crosses the persistence boundary", () => {
  it("carries the origin, and ONLY the origin, in params", () => {
    const { dock } = openedDock();
    const layout = dock.toJSON() as unknown as SerialisedLayout;

    for (const [id, panel] of Object.entries(layout.panels)) {
      // Note 32 §4: "params contains exactly ['origin'] and nothing else".
      // Leaking a message, a catalogue id or a cached component into params
      // fails here immediately.
      expect(Object.keys(panel.params ?? {}), id).toEqual(["origin"]);
    }
    expect(layout.panels["notes"]?.params?.["origin"]).toBe("https://notes.example/app");
    expect(layout.panels["sql"]?.params?.["origin"]).toBe("https://sql.example/console");
  });

  it("leaves content behind — and the content demonstrably existed", () => {
    const { host, dock } = openedDock();

    // POSITIVE CONTROL FIRST. Note 32 §4 records that the original version of
    // this test asserted a restored host contained no old content, which
    // passed trivially because a fresh ShellDock has nothing to replay: it
    // tested the constructor. So this asserts the content was really there —
    // rendered into the live DOM, and present in the live data model —
    // BEFORE asserting it is absent from the serialised layout.
    expect(host.textContent).toContain(NOTES_TEXT);
    expect(host.textContent).toContain(SQL_TEXT);
    expect(dock.renderers.get("notes")?.dataModel("notes")).toEqual({
      draft: "UNSENT-DRAFT-VALUE",
    });

    const json = JSON.stringify(dock.toJSON());
    expect(json).not.toContain(NOTES_TEXT);
    expect(json).not.toContain(SQL_TEXT);
    expect(json).not.toContain("UNSENT-DRAFT-VALUE");
    for (const leak of [
      "updateComponents",
      "createSurface",
      "updateDataModel",
      "catalogId",
      shellCatalog.catalogId,
    ]) {
      expect(json, leak).not.toContain(leak);
    }
  });

  it("keeps titles, but outside params — Dockview stores them separately", () => {
    // Note 32 §7 left this open. It survives THIS code path; the persistence
    // mechanism is Dockview's own `panels[id].title` field, not the shell's
    // params, so a title is not shell-controlled state.
    const { dock } = openedDock();
    const layout = dock.toJSON() as unknown as SerialisedLayout;
    expect(layout.panels["notes"]?.title).toBe("Notes");
    expect(layout.panels["sql"]?.title).toBe("SQL Console");
    expect(layout.panels["notes"]?.params).not.toHaveProperty("title");
  });
});

describe("restoring into a dock that knows nothing", () => {
  /**
   * The restore always goes through `JSON.stringify` into a SEPARATE dock on
   * a SEPARATE host. Nothing in-memory can be smuggled across: only data that
   * survives serialisation can carry identity, and the receiving dock's
   * `pending` map is empty, so no spec can supply the answer.
   */
  function restored(mutate?: (layout: SerialisedLayout) => void): {
    host: HTMLElement;
    dock: ShellDock;
  } {
    const { dock: source } = openedDock();
    const layout = JSON.parse(JSON.stringify(source.toJSON())) as SerialisedLayout;
    mutate?.(layout);
    const host = newHost();
    const dock = createShellDock(host);
    dock.fromJSON(layout as unknown as object);
    return { host, dock };
  }

  it("reassociates every pane with the peer that served it", () => {
    const { dock } = restored();
    expect(dock.paneIds().sort()).toEqual(["notes", "sql"]);
    expect(dock.originOf("notes")).toBe("https://notes.example/app");
    expect(dock.originOf("sql")).toBe("https://sql.example/console");
    // Dockview's own view of params agrees — the round-trip is verbatim.
    const params = Object.fromEntries(
      dock.dockview.panels.map((p) => [p.id, (p.params as { origin?: string }).origin]),
    );
    expect(params).toEqual({
      notes: "https://notes.example/app",
      sql: "https://sql.example/console",
    });
  });

  it("restores a LIVE surface host, which a peer can then repopulate", () => {
    // The positive half of "identity persists, content does not". A restored
    // pane that could not be repopulated would satisfy every absence
    // assertion above and be useless.
    const { host, dock } = restored();
    expect(host.textContent).not.toContain(NOTES_TEXT);

    const renderer = dock.renderers.get("notes");
    expect(renderer).toBeDefined();
    // Standing in for the peer identified by `origin`. Nothing reconnects
    // (note 32 §7): the re-request mechanism does not exist yet.
    for (const message of surfaceMessages("notes", "RE-REQUESTED-CONTENT")) {
      renderer?.handle(message);
    }
    const notesPane = [...host.querySelectorAll(".dv-content-container")].find((c) =>
      c.textContent?.includes("RE-REQUESTED-CONTENT"),
    );
    expect(notesPane).toBeDefined();
    expect(host.textContent).not.toContain(NOTES_TEXT);
  });

  it("survives a layout whose params carry no origin", () => {
    // Note 32 §5: `PaneParams.origin` is typed optional even though the shell
    // always writes it, because a layout could be hand-edited or arrive from
    // an older version. This is what that optionality buys: geometry still
    // restores, and the missing identity is reported as `undefined` rather
    // than crashing or being invented.
    const { dock } = restored((layout) => {
      delete layout.panels["notes"]?.params?.["origin"];
    });
    expect(dock.paneIds().sort()).toEqual(["notes", "sql"]);
    expect(dock.originOf("notes")).toBeUndefined();
    expect(dock.originOf("sql")).toBe("https://sql.example/console");
  });

  it("does not invent an origin from a params key that is not one", () => {
    const { dock } = restored((layout) => {
      const panel = layout.panels["notes"];
      if (panel) panel.params = { peer: "https://impostor.example/" };
    });
    expect(dock.originOf("notes")).toBeUndefined();
  });
});
