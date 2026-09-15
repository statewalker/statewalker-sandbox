import {
  type Placement,
  panelsSlot,
  progressSlot,
  type SlotsReader,
  type UiHost,
  type ViewKind,
} from "@sys/ui";

/**
 * The plain-DOM host: observes `ui:panels` and `ui:progress` and mounts the
 * contributions whose kind it has a renderer for. No React anywhere in its
 * import graph — the `browser:dom` test project proves it.
 */
export interface DomRenderer {
  readonly kind: ViewKind<unknown>;
  mount(container: HTMLElement, model: unknown): () => void;
}

export function domRenderer<M>(
  kind: ViewKind<M>,
  mount: (container: HTMLElement, model: M) => () => void,
): DomRenderer {
  return { kind, mount } as unknown as DomRenderer;
}

export interface DomHostOptions {
  slots: SlotsReader;
  regions: Partial<Record<Placement, HTMLElement>>;
  progress?: HTMLElement;
  renderers: readonly DomRenderer[];
}

interface Mounted {
  readonly contribution: object;
  readonly container: HTMLElement;
  readonly unmount: () => void;
}

export function mountDomHost(options: DomHostOptions): UiHost {
  const byKind = new Map(options.renderers.map((r) => [r.kind.id, r]));
  const panels = new Map<string, Mounted>();
  const bars = new Map<object, Mounted>();

  const mount = (
    renderer: DomRenderer,
    region: HTMLElement,
    contribution: { model: unknown },
    attributes: Record<string, string>,
  ): Mounted => {
    const container = document.createElement("section");
    for (const [name, value] of Object.entries(attributes)) container.setAttribute(name, value);
    region.appendChild(container);
    return { contribution, container, unmount: renderer.mount(container, contribution.model) };
  };
  const release = (m: Mounted) => {
    try {
      m.unmount();
    } finally {
      m.container.remove();
    }
  };

  const offPanels = options.slots.observe(panelsSlot, (entries) => {
    for (const [id, m] of panels) {
      if (entries.get(id) === m.contribution) continue;
      release(m);
      panels.delete(id);
    }
    for (const [id, panel] of entries) {
      if (panels.has(id)) continue;
      const renderer = byKind.get(panel.kind.id);
      const region = options.regions[panel.placement];
      if (!renderer || !region) continue;
      panels.set(
        id,
        mount(renderer, region, panel, { "data-panel": id, "aria-label": panel.title }),
      );
    }
  });

  const offProgress = options.slots.observe(progressSlot, (items) => {
    const live = new Set<object>(items);
    for (const [contribution, m] of bars) {
      if (live.has(contribution)) continue;
      release(m);
      bars.delete(contribution);
    }
    const region = options.progress;
    if (!region) return;
    for (const item of items) {
      if (bars.has(item)) continue;
      const renderer = byKind.get(item.kind.id);
      if (!renderer) continue;
      bars.set(item, mount(renderer, region, item, { "data-progress": item.kind.id }));
    }
  });

  let disposed = false;
  return {
    renders: (slot, { kind, placement }) => {
      if (!byKind.has(kind.id)) return false;
      if (slot === progressSlot.key) return options.progress !== undefined;
      if (slot === panelsSlot.key) return placement !== undefined && !!options.regions[placement];
      return false; // ui:dialogs, or a slot this host does not observe
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      offPanels();
      offProgress();
      for (const m of [...panels.values(), ...bars.values()]) release(m);
      panels.clear();
      bars.clear();
    },
  };
}
