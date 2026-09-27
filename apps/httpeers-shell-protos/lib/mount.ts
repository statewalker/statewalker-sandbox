import type { Catalog } from "./catalog.js";
import { type ActionEvent, type Component, createRenderer, type Renderer } from "./renderer.js";

/**
 * PROTOTYPE 6 — the application module contract.
 *
 * Prototype 1 established that an application is a default module receiving
 * a context, and that the SAME module must work unchanged whether it runs
 * full-window or inside a dock pane. It could not test that: it was
 * headless, and `View.mount(root, ctx)` typed `root` as `unknown`.
 *
 * THE DESIGN RULE that makes "same module, any host" true rather than
 * aspirational: `AppHost` exposes NO surface id, NO pane id, and NO
 * reference to the dock or renderer. A module cannot discover its host, so
 * it cannot branch on it. The surface id is an implementation detail the
 * host chooses and the module never sees.
 *
 * Mutation testing confirmed the tests hold this: leaking `surfaceId` into
 * only the docked host, or duplicating the host builder rather than sharing
 * it, both fail.
 */

export interface AppHost {
  /** Replace the module's component tree. Ids are module-local. */
  render(components: Component[]): void;
  /** Write a value into the module's own data model. */
  setData(path: string, value: unknown): void;
  /** Read the module's own data model. */
  getData(): Record<string, unknown>;
  /** Emit a notification to whatever is hosting this module. */
  notify(message: string): void;
}

export interface AppModule {
  readonly id: string;
  /** Called once when mounted. May return a disposer. */
  activate(host: AppHost): void | (() => void);
}

export interface AppHostOptions {
  onAction?(event: ActionEvent): void;
  onNotify?(message: string): void;
}

export interface MountHandle {
  readonly renderer: Renderer;
  dispose(): void;
}

/**
 * Build the AppHost for one module over one renderer.
 *
 * Shared by BOTH mount paths — standalone and docked — which is what makes
 * the "identical host shape" property hold by construction rather than by
 * careful duplication of two code paths that happen to agree.
 */
export function createAppHost(
  renderer: Renderer,
  surfaceId: string,
  catalog: Catalog,
  options: AppHostOptions = {},
): AppHost {
  renderer.handle({
    version: "v0.9.1",
    createSurface: { surfaceId, catalogId: catalog.catalogId },
  });

  return {
    render(components) {
      renderer.handle({
        version: "v0.9.1",
        updateComponents: { surfaceId, components },
      });
    },
    setData(path, value) {
      renderer.handle({
        version: "v0.9.1",
        updateDataModel: { surfaceId, path, value },
      });
    },
    getData() {
      return renderer.dataModel(surfaceId) ?? {};
    },
    notify(message) {
      options.onNotify?.(message);
    },
  };
}

/**
 * Mount a module full-window into a container.
 *
 * The standalone case is deliberately thin: it is the docked case with a
 * default layout of exactly one pane. If this needed to do anything the
 * docked path does not, the abstraction would be leaking.
 */
export function mountStandalone(
  container: HTMLElement,
  module: AppModule,
  catalog: Catalog,
  options: AppHostOptions = {},
): MountHandle {
  const renderer = createRenderer(container, catalog, {
    ...(options.onAction ? { onAction: options.onAction } : {}),
  });
  const host = createAppHost(renderer, module.id, catalog, options);
  const disposer = module.activate(host);

  return {
    renderer,
    dispose() {
      disposer?.();
      renderer.handle({
        version: "v0.9.1",
        deleteSurface: { surfaceId: module.id },
      });
    },
  };
}
