import { type KeyedSlotDeclaration, type SlotDeclaration, Slots } from "@statewalker/shared-slots";

export { defineKeyedSlot, defineSlot } from "@statewalker/shared-slots";
export type { KeyedSlotDeclaration, SlotDeclaration };

export interface SlotUsage {
  readonly key: string;
  readonly contributions: number;
  readonly observers: number;
  /** A command slot (its contributions are handlers) or the kernel's in-flight calls. */
  readonly command: boolean;
}

type AnyDecl = SlotDeclaration<unknown> | KeyedSlotDeclaration<unknown>;

/**
 * The kernel's slots bus: `@statewalker/shared-slots` plus bookkeeping of who observes and what
 * is contributed per key — the coverage report ("contributed, observed by no one") and the dispose
 * test ("every slot is empty") read it.
 */
export class KernelSlots extends Slots {
  private readonly _decls = new Map<string, AnyDecl>();
  private readonly _observers = new Map<string, number>();

  private _count(key: string, delta: number): void {
    this._observers.set(key, (this._observers.get(key) ?? 0) + delta);
  }

  override provide<T>(decl: SlotDeclaration<T>, value: T): () => void {
    this._decls.set(decl.key, decl as AnyDecl);
    return super.provide(decl, value);
  }

  override register<T>(decl: KeyedSlotDeclaration<T>, id: string, value: T): () => void {
    this._decls.set(decl.key, decl as AnyDecl);
    return super.register(decl, id, value);
  }

  override observe<T>(decl: SlotDeclaration<T>, cb: (values: readonly T[]) => void): () => void;
  override observe<T>(
    decl: KeyedSlotDeclaration<T>,
    cb: (entries: ReadonlyMap<string, T>) => void,
  ): () => void;
  override observe(decl: AnyDecl, cb: (value: never) => void): () => void {
    this._decls.set(decl.key, decl);
    this._count(decl.key, 1);
    let off: () => void;
    try {
      off = (super.observe as (d: AnyDecl, c: (v: never) => void) => () => void)(decl, cb);
    } catch (error) {
      this._count(decl.key, -1);
      throw error;
    }
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this._count(decl.key, -1);
      off();
    };
  }

  /** Every slot key ever touched, with its current contribution and observer counts. */
  usage(): SlotUsage[] {
    return [...this._decls.values()].map((decl) => {
      const snapshot =
        decl._kind === "keyed"
          ? this.getSnapshot(decl as KeyedSlotDeclaration<unknown>).size
          : this.getSnapshot(decl as SlotDeclaration<unknown>).length;
      return {
        key: decl.key,
        contributions: snapshot,
        observers: this._observers.get(decl.key) ?? 0,
        command: "policy" in decl || decl.key === "sys:calls",
      };
    });
  }
}
