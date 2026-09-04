import { DockviewComponent, themeLight } from "dockview-core";
import { shellCatalog } from "./catalog.js";
import { createRenderer, type A2uiMessage, type Renderer } from "./renderer.js";

/**
 * The shell's dock: Dockview hosting one A2UI surface per pane.
 *
 * RUNG 7 established the join. Dockview's `IContentRenderer` requires the
 * component to OWN a readonly `element` — the published examples showing
 * `params.containerElement` are wrong for v8 — which suits the A2UI
 * renderer exactly, since it takes one DOM root.
 *
 * RUNG 7a adds persistence. The question was never whether geometry
 * survives (Dockview ships toJSON/fromJSON) but whether SURFACE IDENTITY
 * survives, so a restored pane can be reassociated with the peer that
 * served it.
 *
 * PACKAGING NOTES (rung 7, browser-verified — none of these are visible in
 * happy-dom):
 *  - Dockview's CSS is embedded in the JS as a string and is NEVER injected.
 *    There is no .css file in the package; it must be extracted from
 *    dist/dockview-core.js into a real stylesheet (~147 KB).
 *  - `themeLight` carries `className: "dockview-theme-light"` which must be
 *    applied to the host element BY HAND. Passing `theme` does not do it.
 */

export interface PaneSpec {
  readonly id: string;
  readonly title: string;
  /**
   * Where the pane's application was served from. Opaque to the shell: a
   * remote HTTPS host and a peer-backed local endpoint are
   * indistinguishable. Persisted so a restored pane can re-request content.
   */
  readonly origin: string;
  /** A2UI messages to replay into this pane's own renderer on first open. */
  readonly messages?: A2uiMessage[];
  readonly position?: {
    referencePanel: string;
    direction: "right" | "below" | "left" | "above";
  };
}

/**
 * The subset of pane state that is persisted. Content is NOT.
 *
 * `origin` is OPTIONAL here even though the shell always writes it:
 * Dockview's `Parameters` type makes no such guarantee, and a layout could
 * arrive from an older version or a hand-edited file. Treating it as
 * required would be a lie the type system correctly rejects.
 */
interface PaneParams {
  readonly origin?: string;
  [key: string]: unknown;
}

export interface ShellDock {
  readonly dockview: DockviewComponent;
  /** One renderer per pane — surfaces do not share a data model. */
  readonly renderers: Map<string, Renderer>;
  addPane(spec: PaneSpec): void;
  paneIds(): string[];
  /** The origin a pane was served from, recovered after a restore. */
  originOf(paneId: string): string | undefined;
  toJSON(): object;
  fromJSON(layout: object): void;
}

export function createShellDock(host: HTMLElement): ShellDock {
  const renderers = new Map<string, Renderer>();
  const pending = new Map<string, PaneSpec>();
  /** Origins by pane id, kept alongside Dockview's own state. */
  const origins = new Map<string, string>();

  const dockview = new DockviewComponent(host, {
    theme: themeLight,
    createComponent: (options) => {
      const element = document.createElement("div");
      element.style.height = "100%";
      element.style.overflow = "auto";
      return {
        element,
        init: (params: { params?: Record<string, unknown> }) => {
          const renderer = createRenderer(element, shellCatalog);
          renderers.set(options.id, renderer);

          // FIRST OPEN: the spec carries messages to replay.
          // RESTORE: params carries the origin and there are no messages —
          // content is re-requested from the peer, never resurrected from
          // storage. A surface is a live conversation; persisting its
          // rendered components would resurrect stale content and store a
          // foreign peer's markup across sessions.
          const spec = pending.get(options.id);
          if (spec?.messages) {
            for (const m of spec.messages) renderer.handle(m);
          }
          const origin =
            spec?.origin ?? (params?.params?.["origin"] as string | undefined);
          if (origin) origins.set(options.id, origin);
        },
      };
    },
  });

  return {
    dockview,
    renderers,

    addPane(spec) {
      pending.set(spec.id, spec);
      origins.set(spec.id, spec.origin);
      dockview.addPanel({
        id: spec.id,
        component: "a2ui-surface",
        title: spec.title,
        // Dockview round-trips `params` verbatim through toJSON/fromJSON.
        // This is the hook that carries surface identity across a restore.
        params: { origin: spec.origin } satisfies PaneParams,
        ...(spec.position ? { position: spec.position } : {}),
      });
    },

    paneIds() {
      return dockview.panels.map((p) => p.id);
    },

    originOf(paneId) {
      return origins.get(paneId);
    },

    toJSON() {
      return dockview.toJSON();
    },

    fromJSON(layout) {
      // Panels are rebuilt by Dockview; createComponent runs again for each
      // and reads the origin back out of params.
      dockview.fromJSON(layout as never);
      for (const panel of dockview.panels) {
        const p = panel.params as PaneParams | undefined;
        if (p?.origin) origins.set(panel.id, p.origin);
      }
    },
  };
}
