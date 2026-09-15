import { newRegistry } from "@statewalker/shared-registry";
import {
  dialogsSlot,
  notificationsSlot,
  type Placement,
  panelsSlot,
  type SlotsReader,
  type UiHost,
  type ViewKind,
} from "@sys/extension-points";
import { type ComponentType, type ReactNode, useLayoutEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import { SlotsProvider, useKeyedSlot, useSlot } from "./slots-context.js";

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
  readonly slots: SlotsReader;
  readonly regions: Partial<Record<Placement, HTMLElement>>;
  readonly dialogs?: HTMLElement;
  readonly notifications?: HTMLElement;
  readonly renderers: readonly ReactRenderer[];
}

type Renderers = ReadonlyMap<string, ReactRenderer>;

/**
 * The React host: observes `ui:panels`, `ui:dialogs` and `ui:notifications`,
 * and renders the contributions whose kind it has a renderer for. It reads the
 * slots bus and never provides to it; renderers are host-local, not contributions.
 */
export function mountReactHost(options: ReactHostOptions): UiHost {
  const byKind: Renderers = new Map(options.renderers.map((r) => [r.kind.id, r]));
  const [register, cleanup] = newRegistry();
  const mount = (element: HTMLElement, node: ReactNode) => {
    const root = createRoot(element);
    root.render(<SlotsProvider slots={options.slots}>{node}</SlotsProvider>);
    register(() => root.unmount());
  };
  for (const [placement, element] of Object.entries(options.regions) as [
    Placement,
    HTMLElement | undefined,
  ][]) {
    if (element) mount(element, <PanelRegion placement={placement} byKind={byKind} />);
  }
  if (options.dialogs) mount(options.dialogs, <DialogRegion byKind={byKind} />);
  if (options.notifications) mount(options.notifications, <NotificationRegion byKind={byKind} />);

  let disposed = false;
  return {
    renders: (slot, { kind, placement }) => {
      if (!byKind.has(kind.id)) return false;
      if (slot === panelsSlot.key)
        return placement !== undefined && options.regions[placement] !== undefined;
      if (slot === dialogsSlot.key) return options.dialogs !== undefined;
      if (slot === notificationsSlot.key) return options.notifications !== undefined;
      return false;
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      void cleanup();
    },
  };
}

function PanelRegion({ placement, byKind }: { placement: Placement; byKind: Renderers }) {
  const panels = useKeyedSlot(panelsSlot);
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

const keys = new WeakMap<object, number>();
let nextKey = 0;
const keyOf = (contribution: object): number => {
  let key = keys.get(contribution);
  if (key === undefined) {
    key = ++nextKey;
    keys.set(contribution, key);
  }
  return key;
};

function DialogRegion({ byKind }: { byKind: Renderers }) {
  const dialogs = useSlot(dialogsSlot);
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

function NotificationRegion({ byKind }: { byKind: Renderers }) {
  const notifications = useSlot(notificationsSlot);
  return (
    <div className="flex flex-col gap-2">
      {notifications.map((notification) => {
        const renderer = byKind.get(notification.kind.id);
        if (!renderer) return null;
        const { Component } = renderer;
        return (
          <div key={keyOf(notification)} data-notification={notification.kind.id}>
            <Component model={notification.model} />
          </div>
        );
      })}
    </div>
  );
}

/**
 * A contributed dialog has no trigger, so nothing returns focus when it goes.
 * Remember where focus was when it appeared; after it is removed, if focus was
 * left on <body>, put it back — in a timeout, after the kit's own focus handling.
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
