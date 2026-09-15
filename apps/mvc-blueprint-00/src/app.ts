import { Commands } from "@statewalker/shared-commands";
import { type BootstrapOptions, bootstrap, type PanelOutcome, TodoListModel } from "@todo/app";
import { MemTodoApi, type Todo, type TodoApi } from "@todo/core";
import { registerViews } from "@todo/ui";

/**
 * The composition root: the one module that knows every layer — the core's
 * api, the app's bootstrap and models, the ui's React views — and wires them.
 * Nothing else in this app may import the core, the app and the React views
 * together (B0 enforces it; a headless suite over `@todo/ui/adapter` is a
 * protocol harness, not a second root, and is not counted). `main.tsx`
 * is only the page's entry: styles, the `#root` element, and a call to this.
 * It is split out so the B6 suite can boot exactly what `pnpm dev` serves.
 */

/** What a first visit shows. In memory: a persistent `TodoApi` is B7. */
export const seedTodos: readonly Todo[] = [
  { id: "seed-1", title: "Read the blueprint spec", done: true },
  { id: "seed-2", title: "Add a todo of your own", done: false },
  { id: "seed-3", title: "Tick it, then clear completed", done: false },
];

export interface StartOptions {
  /** The external service. Defaults to an in-memory api holding `seedTodos`. */
  api?: TodoApi;
  /**
   * The view layer, given the element to render into. Defaults to the real
   * React views. A seam for the suite that proves a broken view layer is loud.
   */
  registerViews?: (mount: HTMLElement) => BootstrapOptions["registerViews"];
}

export interface RunningApp {
  /** Tears the whole app down — controller, views, commands — and empties `root`. */
  dispose(): Promise<void>;
}

/** Boots the TODO app into `root`: bus, then view layer, then the list controller. */
export function startApp(root: HTMLElement, options: StartOptions = {}): RunningApp {
  const commands = new Commands();
  const app = bootstrap({
    commands,
    api: options.api ?? new MemTodoApi([...seedTodos]),
    registerViews: (options.registerViews ?? registerViews)(root),
  });
  const { controller } = app.createList(new TodoListModel());

  // `panelSettled` never rejects and the library never logs: a view layer
  // that cannot show the list (`no-handlers` — nobody registered
  // `ui:show-list`) would otherwise leave a blank page and a silent console.
  // This is the production reader the controller's doc asks for.
  //
  // `disposed` covers the one window where it matters: the failure is
  // settled inside `startApp`, but this reader runs microtasks later, and a
  // caller that disposes in the same turn has already been handed its root
  // back. An app nobody is looking at any more reports nothing — no log, and
  // no element rendered into a root that is no longer ours (without the
  // guard, whether dispose's `failure?.remove()` catches that element would
  // depend on how many microtasks the registry's unwind takes).
  let disposed = false;
  let failure: HTMLElement | undefined;
  void controller.panelSettled.then((outcome: PanelOutcome) => {
    if (outcome.ok || disposed) return;
    console.error("[mvc-blueprint-00] the todo list could not be shown:", outcome.error);
    failure = renderFailure(root, outcome.error);
  });

  return {
    async dispose() {
      disposed = true;
      await app.dispose();
      failure?.remove();
    },
  };
}

/**
 * Plain DOM, not React: it reports that the view layer is broken, so it must
 * not depend on the view layer working.
 */
function renderFailure(root: HTMLElement, error: unknown): HTMLElement {
  const el = document.createElement("div");
  el.setAttribute("role", "alert");
  el.className = "m-4 max-w-xl rounded-md border border-destructive p-4 text-sm text-destructive";
  el.textContent = `The todo list could not be shown: ${error instanceof Error ? error.message : String(error)}`;
  root.appendChild(el);
  return el;
}
