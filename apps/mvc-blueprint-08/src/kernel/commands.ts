import {
  type CommandDeclaration,
  type CommandListener,
  Commands,
} from "@statewalker/shared-commands";

export type { CommandDeclaration, CommandListener } from "@statewalker/shared-commands";
export { Command, CommandError, passthrough } from "@statewalker/shared-commands";

/** The kernel's command bus: `@statewalker/shared-commands` plus a listener count per key (dispose test). */
export class KernelCommands extends Commands {
  private readonly _counts = new Map<string, number>();

  override listen<P, R>(
    decl: CommandDeclaration<P, R>,
    fn: CommandListener<P, R>,
    opts?: { priority?: number },
  ): () => void {
    this._counts.set(decl.key, (this._counts.get(decl.key) ?? 0) + 1);
    const off = super.listen(decl, fn, opts);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this._counts.set(decl.key, (this._counts.get(decl.key) ?? 1) - 1);
      off();
    };
  }

  /** Command keys that currently have at least one listener. */
  listened(): string[] {
    return [...this._counts].filter(([, n]) => n > 0).map(([key]) => key);
  }
}
