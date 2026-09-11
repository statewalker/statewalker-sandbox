import { newRegistry } from "@statewalker/shared-registry";
import type { Command, CommandDeclaration, Commands } from "@statewalker/shared-commands";

/** A rendered view. The renderer gets the model and a settle callback — nothing else. */
export interface ViewHandle<M, R> {
  readonly model: M;
  settle(result: R): void;
}

export type Renderer<M, R> = (view: ViewHandle<M, R>) => (() => void) | void;

/**
 * The view layer is a set of COMMAND HANDLERS, and this is the only file that
 * touches the bus.
 *
 * Keyed on the DECLARATION rather than a fixed renderer struct: the key carries
 * its own input and output types, so each view kind keeps a typed model and a
 * typed result, and the adapter names no application noun. fm-protos' version
 * hardcoded seven keys including `job` and `conflict`, which is why it could
 * not be reused.
 */
export class ViewAdapter {
  private readonly _registry = newRegistry();
  private readonly _open = new Map<Command<unknown, unknown>, { key: string; model: unknown; cleanup?: () => void }>();
  private _disposed = false;

  constructor(private readonly _commands: Commands) {}

  on<P, R>(declaration: CommandDeclaration<P, R>, renderer: Renderer<P, R>): this {
    const [register] = this._registry;
    register(
      this._commands.listen(declaration, (cmd) => {
        if (this._disposed) return undefined;

        const entry: { key: string; model: unknown; cleanup?: () => void } = {
          key: declaration.key,
          model: cmd.payload,
        };

        const cleanup = renderer({
          model: cmd.payload,
          settle: (result: R) => {
            cmd.resolve(result);
          },
        });

        // Returning nothing is observe-only: the renderer declined, so we must
        // not claim, and the caller sees `not-claimed` rather than a hang.
        // A renderer that settled synchronously HAS claimed; one that returned
        // nothing without settling has not.
        if (cleanup === undefined && cmd.settled === false) return undefined;

        entry.cleanup = typeof cleanup === "function" ? cleanup : undefined;
        this._open.set(cmd as Command<unknown, unknown>, entry);

        // The view is removed when the command settles — by EITHER side. The
        // user resolves by acting; the controller resolves to force-close.
        void cmd.promise.then(
          () => this._close(cmd as Command<unknown, unknown>),
          () => this._close(cmd as Command<unknown, unknown>),
        );

        // `true` claims without settling: the long-lived case.
        return cmd.settled ? undefined : true;
      }),
    );
    return this;
  }

  openViews(): { key: string; model: unknown }[] {
    return [...this._open.values()].map(({ key, model }) => ({ key, model }));
  }

  /** Async because the registry unwinds asynchronously (spec §4.9). */
  async dispose(): Promise<void> {
    this._disposed = true;
    const [, cleanup] = this._registry;
    await cleanup();
    // Settle what is still open. A cleanup alone would run the renderer's
    // teardown but leave the caller's `cmd.promise` pending forever — the one
    // path in this design where termination is NOT symmetric.
    for (const cmd of [...this._open.keys()]) {
      this._close(cmd);
      if (!cmd.settled) {
        cmd.reject(new Error("view layer disposed while the view was open"));
      }
    }
  }

  private _close(cmd: Command<unknown, unknown>): void {
    const entry = this._open.get(cmd);
    if (!entry) return;
    this._open.delete(cmd);
    entry.cleanup?.();
  }
}

/**
 * A view layer, in the shape bootstrap's `registerViews` option takes: given
 * the bus, build ONE adapter, let `install` register its renderers, and hand
 * back the adapter's `dispose` as the cleanup — so bootstrap's LIFO registry
 * unwinds the view layer after the controllers that use it (spec §4.9, §4.12).
 *
 * It lives here, not beside the renderers, because it is the one place that
 * has to NAME the bus, and B0 confines that name to this file: a module that
 * mounts React views gets the adapter, never `Commands` (spec §4.3).
 */
export function viewLayer(
  install: (adapter: ViewAdapter) => void,
): (commands: Commands) => () => Promise<void> {
  return (commands) => {
    const adapter = new ViewAdapter(commands);
    install(adapter);
    return () => adapter.dispose();
  };
}
