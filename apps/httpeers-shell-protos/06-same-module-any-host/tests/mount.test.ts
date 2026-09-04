// DERIVED-FROM-NOTE: 33-Prototype 6: Same Module, Any Host
//   §2 "The rule that makes it true rather than aspirational"
//   §3 "Standalone is the degenerate case"
//   §4 "Mutation testing"
//   §5 "Isolation between hosted modules"
//   §7 "Open threads"
// DERIVED-FROM-NOTE: 23-Revised Prototype Plan: Visual Layer §3 (rung 6 row)
//
// RECONSTRUCTED, not recovered: rung 6 has no archive. Its code survived
// consolidation into shell-core (`lib/mount.ts`), so this file is a fresh
// test suite written against the note's claims and against the code that
// note produced.
//
// ONE DIVERGENCE FROM THE NOTE, stated up front. Note 33 describes the
// docked path as `dock.mountApp`, calling the shared `createAppHost`.
// Consolidated `lib/dock.ts` (rungs 7 and 7a) has NO `mountApp`: a pane
// owns its renderer, and the AppHost is composed on top by whoever mounts
// the module. The property under test is unaffected — `createAppHost` is
// still the one and only host builder — but the docked path is assembled
// here rather than imported, and that is said out loud because the whole
// point of this rung is that the two paths are not quietly two.

import { beforeEach, describe, expect, it } from "vitest";
import { shellCatalog } from "../../lib/catalog.js";
import { createShellDock } from "../../lib/dock.js";
import {
  createAppHost,
  mountStandalone,
  type AppHost,
  type AppModule,
} from "../../lib/mount.js";
import { createRenderer, type ActionEvent, type Renderer } from "../../lib/renderer.js";

/** The AppHost contract, spelled out so a leak is a diff and not a judgement call. */
const APP_HOST_KEYS = ["getData", "notify", "render", "setData"] as const;

/**
 * Everything a module would need in order to branch on its host. Note 33 §2:
 * "A module CANNOT discover its host, so it cannot branch on it."
 */
const FORBIDDEN_KEYS = [
  "surfaceId",
  "paneId",
  "id",
  "dock",
  "dockview",
  "renderer",
  "container",
  "element",
  "host",
  "standalone",
  "docked",
] as const;

interface Trace {
  readonly hosts: AppHost[];
  readonly activateArgCounts: number[];
  readonly disposals: string[];
}

/**
 * ONE module definition, used by BOTH paths. If it had to be parameterised
 * per host the rung would already have rejected.
 */
function confirmModule(trace: Trace): AppModule {
  return {
    id: "confirm-dialog",
    activate(...args) {
      const host = args[0] as AppHost;
      trace.hosts.push(host);
      trace.activateArgCounts.push(args.length);
      host.setData("/form/name", "");
      host.render([
        { id: "root", component: "Column", children: ["title", "field", "row"] },
        { id: "title", component: "Text", text: "Confirm", variant: "h1" },
        {
          id: "field",
          component: "TextField",
          label: "Name",
          value: { path: "/form/name" },
        },
        { id: "row", component: "Row", children: ["ok"] },
        {
          id: "ok",
          component: "Button",
          child: "okLabel",
          variant: "primary",
          action: { event: { name: "confirm", context: { from: "module" } } },
        },
        { id: "okLabel", component: "Text", text: "OK" },
      ]);
      return () => {
        trace.disposals.push("confirm-dialog");
      };
    },
  };
}

function newTrace(): Trace {
  return { hosts: [], activateArgCounts: [], disposals: [] };
}

/**
 * PATH A — full window. `mountStandalone` chooses the module's OWN id as the
 * surface id; the caller supplies the DOM root and never learns the id back.
 */
function mountStandaloneWith(
  module: AppModule,
  container: HTMLElement,
  onAction?: (e: ActionEvent) => void,
  onNotify?: (m: string) => void,
) {
  return mountStandalone(container, module, shellCatalog, {
    ...(onAction ? { onAction } : {}),
    ...(onNotify ? { onNotify } : {}),
  });
}

/**
 * PATH B — inside a Dockview pane. Genuinely different from path A:
 *   - the DOM root is created and owned by Dockview, not by the caller;
 *   - the renderer is built by `dock.createComponent`, not by `mountStandalone`;
 *   - the surface id is the PANE id, which differs from the module id;
 *   - a sibling pane exists, so this is not a one-surface world.
 * If those were the same, the "no divergence" assertions would prove nothing.
 */
function mountDocked(
  module: AppModule,
  paneId: string,
  onAction?: (e: ActionEvent) => void,
  onNotify?: (m: string) => void,
) {
  const dockHost = document.createElement("div");
  dockHost.id = "dock-root";
  document.body.appendChild(dockHost);
  const dock = createShellDock(dockHost);
  // happy-dom reports every element as 0x0; Dockview needs a measurement.
  dock.dockview.layout(1200, 800);
  dock.addPane({ id: paneId, title: "Confirm", origin: "https://peer.example/app" });
  const renderer = dock.renderers.get(paneId) as Renderer;
  const host = createAppHost(renderer, paneId, shellCatalog, {
    ...(onAction ? { onAction } : {}),
    ...(onNotify ? { onNotify } : {}),
  });
  const disposer = module.activate(host);
  return { dock, dockHost, paneId, renderer, host, disposer };
}

const surfaceBody = (root: HTMLElement) =>
  (root.querySelector("[data-surface]") as HTMLElement).innerHTML;

const surfaceIdOf = (root: HTMLElement) =>
  (root.querySelector("[data-surface]") as HTMLElement).getAttribute("data-surface");

let container: HTMLElement;

beforeEach(() => {
  document.body.innerHTML = "";
  container = document.createElement("div");
  container.id = "standalone-root";
  document.body.appendChild(container);
});

describe("the two paths really are two", () => {
  // NON-VACUITY GUARD. Every "no divergence" assertion below is worthless
  // if the two mounts are secretly the same mount. These run first.
  it("uses a different surface id, a different root and a different renderer", () => {
    const trace = newTrace();
    const module = confirmModule(trace);
    const standalone = mountStandaloneWith(module, container);
    const docked = mountDocked(module, "pane-alpha");

    expect(surfaceIdOf(container)).toBe("confirm-dialog");
    expect(surfaceIdOf(docked.dockHost)).toBe("pane-alpha");
    expect(surfaceIdOf(container)).not.toBe(surfaceIdOf(docked.dockHost));

    expect(standalone.renderer).not.toBe(docked.renderer);
    expect(container.contains(docked.dockHost)).toBe(false);
    expect(docked.dockHost.contains(container)).toBe(false);
    // The docked surface is nested inside DOM Dockview built, not the caller's.
    expect(docked.dockHost.querySelector("[data-surface]")!.parentElement).not.toBe(
      docked.dockHost,
    );
  });
});

describe("the host has the same shape in both", () => {
  it("exposes exactly the four AppHost members, and the same four", () => {
    // MUTATION 1 from note 33 §4: leaking `surfaceId` into the docked host
    // only. This is the assertion that catches it.
    const trace = newTrace();
    const module = confirmModule(trace);
    mountStandaloneWith(module, container);
    mountDocked(module, "pane-alpha");

    const [standaloneHost, dockedHost] = trace.hosts;
    const keys = (h: AppHost) => Object.keys(h).sort();
    expect(keys(standaloneHost!)).toEqual([...APP_HOST_KEYS]);
    expect(keys(dockedHost!)).toEqual([...APP_HOST_KEYS]);
    expect(keys(standaloneHost!)).toEqual(keys(dockedHost!));
  });

  it("exposes nothing a module could branch on", () => {
    // Note 33 §4: "A second test asserts directly that none of surfaceId,
    // paneId, dock, dockview or renderer appears on the host object."
    const trace = newTrace();
    const module = confirmModule(trace);
    mountStandaloneWith(module, container);
    mountDocked(module, "pane-alpha");

    for (const host of trace.hosts) {
      for (const forbidden of FORBIDDEN_KEYS) {
        expect(forbidden in (host as object), `${forbidden} is reachable`).toBe(false);
      }
      // Nothing but functions: no data field can carry the id either.
      expect(Object.values(host).every((v) => typeof v === "function")).toBe(true);
    }
  });

  it("hands the module one argument and nothing else", () => {
    // A second parameter would be the obvious place for "which host am I".
    const trace = newTrace();
    const module = confirmModule(trace);
    mountStandaloneWith(module, container);
    mountDocked(module, "pane-alpha");
    expect(trace.activateArgCounts).toEqual([1, 1]);
  });

  it("is built by ONE builder, so the shapes cannot drift apart", () => {
    // MUTATION 2 from note 33 §4, the one that matters: duplicating the host
    // builder inline in one path. A bare `createAppHost` over a throwaway
    // renderer must be key-identical to what `mountStandalone` produced —
    // if mountStandalone built its own, the drift shows here first.
    const trace = newTrace();
    const module = confirmModule(trace);
    mountStandaloneWith(module, container);

    const bare = document.createElement("div");
    document.body.appendChild(bare);
    const direct = createAppHost(
      createRenderer(bare, shellCatalog),
      "any-id-at-all",
      shellCatalog,
    );
    expect(Object.keys(direct).sort()).toEqual(Object.keys(trace.hosts[0]!).sort());
  });
});

describe("the same module produces the same result in both", () => {
  it("renders byte-identical markup", () => {
    // THE CENTRAL CLAIM. Component ids are module-local, so the only thing
    // that could differ is something host-derived leaking into the tree.
    const standaloneTrace = newTrace();
    const dockedTrace = newTrace();
    mountStandaloneWith(confirmModule(standaloneTrace), container);
    const docked = mountDocked(confirmModule(dockedTrace), "pane-alpha");

    expect(surfaceBody(container)).toBe(surfaceBody(docked.dockHost));
    // And it is not identical because both are empty.
    expect(surfaceBody(container)).toContain("data-component=\"Button\"");
    expect(surfaceBody(container).length).toBeGreaterThan(100);
  });

  it("never writes the surface id into the module's own markup", () => {
    const docked = mountDocked(confirmModule(newTrace()), "pane-alpha");
    expect(surfaceBody(docked.dockHost)).not.toContain("pane-alpha");
    mountStandaloneWith(confirmModule(newTrace()), container);
    expect(surfaceBody(container)).not.toContain("confirm-dialog");
  });

  it("round-trips data through setData/getData the same way", () => {
    const standaloneTrace = newTrace();
    const dockedTrace = newTrace();
    mountStandaloneWith(confirmModule(standaloneTrace), container);
    mountDocked(confirmModule(dockedTrace), "pane-alpha");

    for (const host of [standaloneTrace.hosts[0]!, dockedTrace.hosts[0]!]) {
      expect(host.getData()).toEqual({ form: { name: "" } });
      host.setData("/form/name", "Ada");
      expect(host.getData()).toEqual({ form: { name: "Ada" } });
    }
    // `input.value` is a DOM PROPERTY, not an attribute, so it is invisible
    // in innerHTML. Assert the property, or this passes for the wrong reason.
    expect((container.querySelector("input") as HTMLInputElement).value).toBe("Ada");
  });

  it("renders the same action affordance in both, carrying only the host's own id", () => {
    const standaloneSeen: ActionEvent[] = [];
    mountStandaloneWith(confirmModule(newTrace()), container, (e) =>
      standaloneSeen.push(e),
    );
    const docked = mountDocked(confirmModule(newTrace()), "pane-alpha");

    // Identical markup, identical declared action, in both.
    for (const root of [container, docked.dockHost]) {
      const btn = root.querySelector("button") as HTMLElement;
      expect(btn.getAttribute("data-action")).toBe("confirm");
    }

    (container.querySelector("button") as HTMLElement).click();
    expect(standaloneSeen).toHaveLength(1);
    expect(standaloneSeen[0]!.name).toBe("confirm");
    expect(standaloneSeen[0]!.context).toEqual({ from: "module" });
    // The surface id is the ONE thing the event carries that the module did
    // not supply — the host chose it, and the module never saw it.
    expect(standaloneSeen[0]!.surfaceId).toBe("confirm-dialog");
  });

  it("DEFECT — a docked module's actions never fire: createAppHost drops onAction", () => {
    // ------------------------------------------------------------------
    // FOUND BY THIS RUNG, REPORTED NOT FIXED (lib/ is read-only here).
    //
    // `AppHostOptions` declares `onAction?`, and `createAppHost` takes an
    // `AppHostOptions` — but it only ever reads `onNotify`. Actions are
    // wired at RENDERER CONSTRUCTION (`createRenderer(root, catalog,
    // { onAction })`), which `mountStandalone` does and nothing else can:
    // `lib/dock.ts` builds each pane's renderer itself, with no options and
    // no hook to supply any.
    //
    // So a module mounted into a pane renders correctly, holds data
    // correctly, and its buttons are dead. The option is accepted and
    // silently ignored — the same trap as the documented `theme` hole, but
    // undocumented.
    //
    // This is a WIRING gap, not a hole in the "same module, any host"
    // abstraction: the third assertion below shows the identical module and
    // the identical host produce the identical event as soon as the
    // renderer is the one carrying the callback. That distinction is the
    // finding. This test turns RED when the wiring is fixed, which is the
    // point.
    // ------------------------------------------------------------------
    const standaloneSeen: ActionEvent[] = [];
    const dockedSeen: ActionEvent[] = [];
    mountStandaloneWith(confirmModule(newTrace()), container, (e) =>
      standaloneSeen.push(e),
    );
    const docked = mountDocked(confirmModule(newTrace()), "pane-alpha", (e) =>
      dockedSeen.push(e),
    );

    (container.querySelector("button") as HTMLElement).click();
    (docked.dockHost.querySelector("button") as HTMLElement).click();

    expect(standaloneSeen).toHaveLength(1);
    expect(dockedSeen).toHaveLength(0); // <- the defect

    // Cause, isolated: the callback has to be on the RENDERER. Give it to
    // `createRenderer` and the same module, through the same `createAppHost`,
    // produces an event equal to the standalone one in every field the
    // module can observe.
    const wired: ActionEvent[] = [];
    const paneLike = document.createElement("div");
    document.body.appendChild(paneLike);
    const renderer = createRenderer(paneLike, shellCatalog, {
      onAction: (e) => wired.push(e),
    });
    confirmModule(newTrace()).activate(
      createAppHost(renderer, "pane-beta", shellCatalog),
    );
    (paneLike.querySelector("button") as HTMLElement).click();

    const strip = (e: ActionEvent) => ({
      name: e.name,
      context: e.context,
      dataModel: e.dataModel,
    });
    expect(wired).toHaveLength(1);
    expect(strip(wired[0]!)).toEqual(strip(standaloneSeen[0]!));
    expect(wired[0]!.surfaceId).toBe("pane-beta");
  });

  it("routes notify to whatever is embedding the module, in both", () => {
    const standaloneSeen: string[] = [];
    const dockedSeen: string[] = [];
    const sTrace = newTrace();
    const dTrace = newTrace();
    mountStandaloneWith(confirmModule(sTrace), container, undefined, (m) =>
      standaloneSeen.push(m),
    );
    mountDocked(confirmModule(dTrace), "pane-alpha", undefined, (m) =>
      dockedSeen.push(m),
    );
    sTrace.hosts[0]!.notify("saved");
    dTrace.hosts[0]!.notify("saved");
    expect(standaloneSeen).toEqual(["saved"]);
    expect(dockedSeen).toEqual(["saved"]);
  });
});

describe("isolation between hosted modules", () => {
  it("gives two panes running the SAME module separate data models", () => {
    // Note 33 §5. Falls out of one renderer per pane (rung 7); asserted here
    // because the shared-module claim is what makes it non-obvious.
    const dockHost = document.createElement("div");
    document.body.appendChild(dockHost);
    const dock = createShellDock(dockHost);
    dock.dockview.layout(1200, 800);
    dock.addPane({ id: "pane-a", title: "A", origin: "https://peer.example/app" });
    dock.addPane({
      id: "pane-b",
      title: "B",
      origin: "https://peer.example/app",
      position: { referencePanel: "pane-a", direction: "right" },
    });

    const module = confirmModule(newTrace());
    for (const id of ["pane-a", "pane-b"]) {
      const host = createAppHost(dock.renderers.get(id)!, id, shellCatalog);
      module.activate(host);
    }

    const inputs = Array.from(dockHost.querySelectorAll("input"));
    expect(inputs).toHaveLength(2);
    inputs[0]!.value = "typed into A";
    inputs[0]!.dispatchEvent(new Event("input"));

    expect(dock.renderers.get("pane-a")!.dataModel("pane-a")).toEqual({
      form: { name: "typed into A" },
    });
    expect(dock.renderers.get("pane-b")!.dataModel("pane-b")).toEqual({
      form: { name: "" },
    });
  });
});

describe("standalone is the degenerate case, not a second implementation", () => {
  it("disposes by running the module's disposer and deleting the surface", () => {
    const trace = newTrace();
    const handle = mountStandaloneWith(confirmModule(trace), container);
    expect(handle.renderer.surfaces()).toEqual(["confirm-dialog"]);
    handle.dispose();
    expect(trace.disposals).toEqual(["confirm-dialog"]);
    expect(handle.renderer.surfaces()).toEqual([]);
    expect(container.querySelector("[data-surface]")).toBeNull();
  });

  it("KNOWN GAP: closing a dock pane does not run the module's disposer", () => {
    // Note 33 §7, recorded rather than fixed. Dockview's disposal events are
    // not wired to the module lifecycle, so a closed pane leaves the module
    // believing it is still mounted. This test exists so the gap is visible
    // and so closing it is a deliberate act that turns this red.
    const trace = newTrace();
    const docked = mountDocked(confirmModule(trace), "pane-alpha");
    const panel = docked.dock.dockview.panels.find((p) => p.id === "pane-alpha")!;
    docked.dock.dockview.removePanel(panel);
    expect(docked.dock.paneIds()).toEqual([]);
    expect(trace.disposals).toEqual([]);
  });
});
