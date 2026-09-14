import { BaseClass } from "@statewalker/shared-baseclass";

/**
 * BaseClass, raised to the MODELS.md contract. BaseClass itself notifies every
 * listener on every change, calls nobody on subscribe, and lets a throwing
 * listener stop the rest; `channel` adds the immediate call, per-group change
 * filtering and listener isolation, and `commit` adds compare-before-write and
 * the post-dispose no-op.
 */
export abstract class ModelBase extends BaseClass {
  private _disposed = false;

  get isDisposed(): boolean {
    return this._disposed;
  }

  protected channel<T>(read: () => T): (listener: () => void) => () => void {
    return (listener) => {
      if (this._disposed) return () => {};
      let active = true;
      const call = () => {
        if (!active || this._disposed) return;
        try {
          listener();
        } catch (error) {
          console.error(error);
        }
      };
      let prev = read();
      const off = this.onUpdate(() => {
        const next = read();
        if (next === prev) return;
        prev = next;
        call();
      });
      call();
      return () => {
        if (!active) return;
        active = false;
        off();
      };
    };
  }

  /** Applies a write and notifies once — unless the write reports no change, or the model is disposed. */
  protected commit(apply: () => boolean): void {
    if (this._disposed) return;
    if (apply()) this.notify();
  }

  dispose(): void {
    this._disposed = true;
  }
}
