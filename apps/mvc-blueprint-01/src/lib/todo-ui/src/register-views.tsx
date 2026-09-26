import type { CommandDeclaration } from "@statewalker/shared-commands";
import { uiConfirm, uiNotify, uiShowList, uiShowMenu } from "@todo/app/models";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { type ViewAdapter, type ViewHandle, viewLayer } from "./view-adapter.js";
import { ConfirmView } from "./views/confirm-view.js";
import { ListView } from "./views/list-view.js";
import { MenuView } from "./views/menu-view.js";
import { NotifyView } from "./views/notify-view.js";

export interface ViewOptions {
  /** How long a `ui:notify` toast stays up. Defaults to `NOTIFY_TIMEOUT_MS`. */
  notifyTimeoutMs?: number;
}

/**
 * The React view layer, ready for bootstrap's `registerViews` option:
 *
 * ```ts
 * bootstrap({ commands, api, registerViews: registerViews(root) });
 * ```
 *
 * Each `ui:*` command is rendered into its OWN container under `mount` — a
 * fresh `div` with its own React root, tagged with the command key (the only
 * name a view has, spec §4.1) — and the renderer's cleanup unmounts that root
 * and removes the `div`. The adapter runs the cleanup when the command
 * settles, from either side; its `dispose` is the cleanup bootstrap gets.
 *
 * This module never names the bus: it is handed the ADAPTER by `viewLayer`,
 * which is where B0 allows the bus to be named (spec §4.3).
 */
export function registerViews(mount: HTMLElement, options: ViewOptions = {}) {
  return viewLayer((adapter) => {
    show(adapter, mount, uiShowList, ({ model }) => <ListView model={model} />);
    show(adapter, mount, uiConfirm, ({ model, settle }) => (
      <ConfirmView model={model} settle={settle} />
    ));
    show(adapter, mount, uiNotify, ({ model, settle }) => (
      <NotifyView model={model} settle={settle} timeoutMs={options.notifyTimeoutMs} />
    ));
    show(adapter, mount, uiShowMenu, ({ model, settle }) => (
      <MenuView model={model} settle={settle} />
    ));
  });
}

/** Registers `render` for `declaration`, mounting each view into a container of its own. */
function show<M, R>(
  adapter: ViewAdapter,
  mount: HTMLElement,
  declaration: CommandDeclaration<M, R>,
  render: (view: ViewHandle<M, R>) => ReactNode,
): void {
  adapter.on(declaration, (view) => {
    // Where the user was when this view appeared. A command-opened dialog has
    // no trigger, and Radix returns focus only to a trigger — so without this,
    // every answered confirm left the keyboard on <body>.
    const opener = document.activeElement;
    const container = document.createElement("div");
    container.dataset.view = declaration.key;
    mount.appendChild(container);
    const root = createRoot(container);
    root.render(render(view));
    // Returning the cleanup is what CLAIMS the command: the view stays up
    // until the command settles, and this runs then.
    return () => {
      // Restored only if closing THIS view is what lost the focus: the
      // focused element was one this unmount removed (a dialog's button, in
      // its portal). A toast expiring while the user types elsewhere must not
      // pull them back to where they were when it appeared.
      const focused = document.activeElement;
      root.unmount();
      container.remove();
      const lost = focused !== null && focused !== document.body && !focused.isConnected;
      if (lost && opener instanceof HTMLElement && opener !== document.body && opener.isConnected) {
        opener.focus();
      }
    };
  });
}
