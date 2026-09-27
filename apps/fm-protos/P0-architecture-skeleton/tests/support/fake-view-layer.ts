import type { PanelModel } from "@fm/app";
import { uiShowJob, uiShowPanel } from "@fm/app";
import type { JobModel } from "@fm/core";
import type { Command, Commands } from "@statewalker/shared-commands";

/**
 * Stands in for `fm-ui`. It knows only models and the bus — exactly what the
 * real view-layer adapter is allowed to know. Every "component" here is a
 * render counter over a model, which is enough to assert that progress is
 * observed as state rather than pushed as events.
 */
class OpenView<M extends { onUpdate: (cb: () => void) => () => void }> {
  renderCount = 1;
  private readonly _off: () => void;

  constructor(
    readonly model: M,
    private readonly _cmd: Command<unknown, unknown>,
    private readonly _onClose: () => void,
  ) {
    this._off = model.onUpdate(() => {
      this.renderCount++;
    });
    // The view is removed when the command settles — by either side.
    this._cmd.promise.then(
      () => this.dispose(),
      () => this.dispose(),
    );
  }

  /** Removal on settle is async (the bus settles through a microtask). */
  settleFromUser(): Promise<unknown> {
    this._cmd.resolve({ closed: true });
    return this._cmd.promise.catch(() => undefined);
  }

  dispose(): void {
    this._off();
    this._onClose();
  }
}

export class FakeViewLayer {
  readonly openPanels: OpenView<PanelModel>[] = [];
  readonly openJobs: OpenView<JobModel>[] = [];
  private readonly _disposers: (() => void)[] = [];

  constructor(private readonly _commands: Commands) {}

  register(): void {
    this._disposers.push(
      this._commands.listen(uiShowPanel, (cmd) => {
        const view = new OpenView(cmd.payload, cmd as never, () => {
          const i = this.openPanels.indexOf(view);
          if (i >= 0) this.openPanels.splice(i, 1);
        });
        this.openPanels.push(view);
        return true; // claim without settling: a long-lived view
      }),
      this._commands.listen(uiShowJob, (cmd) => {
        const view = new OpenView(cmd.payload, cmd as never, () => {
          const i = this.openJobs.indexOf(view);
          if (i >= 0) this.openJobs.splice(i, 1);
        });
        this.openJobs.push(view);
        return true;
      }),
    );
  }

  /** Every UI handler rejects its outstanding commands on dispose. */
  dispose(): void {
    for (const off of this._disposers) off();
    for (const view of [...this.openPanels, ...this.openJobs]) view.dispose();
  }
}
