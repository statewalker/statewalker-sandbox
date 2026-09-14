import {
  type DialogContribution,
  dialogsSlot,
  type Placement,
  panelsSlot,
  type SlotsReader,
  type UiHost,
  type ViewKind,
} from "@sys/ui";
import {
  type ComponentType,
  type ReactNode,
  useCallback,
  useLayoutEffect,
  useRef,
  useSyncExternalStore,
} from "react";
import { createRoot, type Root } from "react-dom/client";

/**
 * The React host: observes `ui:panels` and `ui:dialogs`, and renders the
 * contributions whose kind it has a renderer for. It reads the slots bus and
 * never provides to it.
 */
export interface ReactRenderer {
  readonly kind: ViewKind<unknown>;
  readonly Component: ComponentType<{ model: unknown }>;
}

export function reactRenderer<M>(
  kind: ViewKind<M>,
  Component: ComponentType<{ model: M }>,
): ReactRenderer {
  return { kind, Component } as unknown as ReactRenderer;
}

export interface ReactHostOptions {
  slots: SlotsReader;
  regions: Partial<Record<Placement, HTMLElement>>;
  dialogs?: HTMLElement;
  renderers: readonly ReactRenderer[];
}

type Renderers = ReadonlyMap<string, ReactRenderer>;

export function mountReactHost(options: ReactHostOptions): UiHost {
  const byKind: Renderers = new Map(options.renderers.map((r) => [r.kind.id, r]));
  const roots: Root[] = [];
  for (const [placement, element] of Object.entries(options.regions) as [
    Placement,
    HTMLElement | undefined,
  ][]) {
    if (!element) continue;
    const root = createRoot(element);
    root.render(<PanelRegion slots={options.slots} placement={placement} byKind={byKind} />);
    roots.push(root);
  }
  if (options.dialogs) {
    const root = createRoot(options.dialogs);
    root.render(<DialogRegion slots={options.slots} byKind={byKind} />);
    roots.push(root);
  }
  let disposed = false;
  return {
    renders: (slot, { kind, placement }) => {
      if (!byKind.has(kind.id)) return false;
      if (slot === dialogsSlot.key) return options.dialogs !== undefined;
      if (slot === panelsSlot.key) return placement !== undefined && !!options.regions[placement];
      return false; // ui:progress, or a slot this host does not observe
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      for (const root of roots) root.unmount();
    },
  };
}

function PanelRegion({
  slots,
  placement,
  byKind,
}: {
  slots: SlotsReader;
  placement: Placement;
  byKind: Renderers;
}) {
  const subscribe = useCallback(
    (onChange: () => void) => slots.observe(panelsSlot, () => onChange()),
    [slots],
  );
  const panels = useSyncExternalStore(subscribe, () => slots.getSnapshot(panelsSlot));
  const shown: ReactNode[] = [];
  for (const [id, panel] of panels) {
    if (panel.placement !== placement) continue;
    const renderer = byKind.get(panel.kind.id);
    if (!renderer) continue;
    const { Component } = renderer;
    shown.push(
      <section key={id} data-panel={id} aria-label={panel.title}>
        <Component model={panel.model} />
      </section>,
    );
  }
  return <>{shown}</>;
}

const dialogKeys = new WeakMap<object, number>();
let nextDialogKey = 0;
const keyOf = (dialog: DialogContribution): number => {
  let key = dialogKeys.get(dialog);
  if (key === undefined) {
    key = ++nextDialogKey;
    dialogKeys.set(dialog, key);
  }
  return key;
};

function DialogRegion({ slots, byKind }: { slots: SlotsReader; byKind: Renderers }) {
  const subscribe = useCallback(
    (onChange: () => void) => slots.observe(dialogsSlot, () => onChange()),
    [slots],
  );
  const dialogs = useSyncExternalStore(subscribe, () => slots.getSnapshot(dialogsSlot));
  return (
    <>
      {dialogs.map((dialog) => {
        const renderer = byKind.get(dialog.kind.id);
        if (!renderer) return null;
        const { Component } = renderer;
        return (
          <FocusReturn key={keyOf(dialog)}>
            <div data-dialog={dialog.kind.id}>
              <Component model={dialog.model} />
            </div>
          </FocusReturn>
        );
      })}
    </>
  );
}

/**
 * A contributed dialog has no trigger, so nothing returns focus when it goes.
 * Remember where focus was when the dialog appeared; after it is removed, if
 * focus was left on <body>, put it back. A timeout, so it runs after the kit's
 * own focus handling on unmount.
 */
function FocusReturn({ children }: { children: ReactNode }) {
  const opener = useRef<Element | null>(null);
  useLayoutEffect(() => {
    opener.current = document.activeElement;
    return () => {
      const back = opener.current;
      setTimeout(() => {
        if (document.activeElement && document.activeElement !== document.body) return;
        if (back instanceof HTMLElement && back !== document.body && back.isConnected) back.focus();
      }, 0);
    };
  }, []);
  return <>{children}</>;
}
