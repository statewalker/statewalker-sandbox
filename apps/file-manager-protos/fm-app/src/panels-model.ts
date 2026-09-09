import { BaseClass } from "@statewalker/shared-baseclass";
import { PanelModel } from "./panel-model.js";

export interface PanelSpec {
  storage: string;
  path: string;
  slot?: string;
  name?: string;
}

export interface TargetChoice {
  id: string;
  /** With exactly two panels the answer is unambiguous, so no picker is shown. */
  needsPicker: boolean;
}

let seq = 0;

/**
 * C2 — two orders over ONE id set.
 *
 * `order` is a stable ring: Tab walks it and activation never reorders it. If
 * activation reordered what Tab walks, panels C…N become unreachable, because
 * every Tab press would put the last-used pair back at the front.
 *
 * `mru` is an activation stack with the active panel at its head. It answers a
 * different question — "which panel did the user mean?" — and that is what the
 * operation target reads.
 *
 * One list cannot do both.
 */
export class PanelsModel extends BaseClass {
  order: string[] = [];
  mru: string[] = [];
  activeId?: string;

  private readonly _panels = new Map<string, PanelModel>();
  private readonly _slots: string[];

  constructor(options: { slots: string[] }) {
    super();
    this._slots = [...options.slots];
  }

  get(id: string): PanelModel {
    const panel = this._panels.get(id);
    if (!panel) throw new Error(`Unknown panel: ${id}`);
    return panel;
  }

  add(spec: PanelSpec): PanelModel {
    const id = `panel-${++seq}`;
    const slot = spec.slot ?? this._firstFreeSlot();
    const panel = new PanelModel(id, slot, spec.storage, spec.path);
    panel.name = spec.name ?? this._name(spec.path);
    this._panels.set(id, panel);

    // Inserted after the active panel: a new panel appears next to the one the
    // user was working in, not at the far end of the ring.
    const at = this.activeId ? this.order.indexOf(this.activeId) + 1 : this.order.length;
    this.order = [...this.order.slice(0, at), id, ...this.order.slice(at)];
    this.mru = [id, ...this.mru];
    this.activeId = id;
    this.notify();
    return panel;
  }

  remove(id: string): void {
    if (!this._panels.has(id)) return;
    this._panels.delete(id);
    this.order = this.order.filter((x) => x !== id);
    this.mru = this.mru.filter((x) => x !== id);
    // The active panel's successor is mru[1] — the panel the user was in
    // before this one — which is now mru[0] after the filter.
    if (this.activeId === id) this.activeId = this.mru[0];
    this.notify();
  }

  activate(id: string): void {
    if (!this._panels.has(id) || this.activeId === id) return;
    this.mru = [id, ...this.mru.filter((x) => x !== id)];
    this.activeId = id;
    this.notify();
  }

  /** Tab. Returns the newly active id, or undefined when there are no panels. */
  next(): string | undefined {
    return this._step(1);
  }

  /** Shift-Tab. */
  previous(): string | undefined {
    return this._step(-1);
  }

  /** Operations need a source and a target; one panel cannot supply both. */
  canOperate(): boolean {
    return this.order.length >= 2;
  }

  /**
   * The most recently used OTHER panel. With two panels this degrades to "the
   * other one" and no picker appears; with three or more, the picker is shown
   * with this preselected, so Enter is always the sensible answer.
   */
  targetFor(sourceId: string): TargetChoice | undefined {
    const candidates = this.mru.filter((id) => id !== sourceId);
    if (candidates.length === 0) return undefined;
    return { id: candidates[0], needsPicker: this.order.length > 2 };
  }

  /** Picker contents, in MRU order — most recently used first. */
  pickerOrder(sourceId: string): string[] {
    return this.mru.filter((id) => id !== sourceId);
  }

  private _step(delta: number): string | undefined {
    if (this.order.length === 0) return undefined;
    const at = this.activeId ? this.order.indexOf(this.activeId) : -1;
    const next = this.order[(at + delta + this.order.length) % this.order.length];
    this.activate(next);
    return next;
  }

  /** A slot already held by a live panel is not free. Removal frees it. */
  private _firstFreeSlot(): string | undefined {
    const taken = new Set([...this._panels.values()].map((p) => p.slot));
    return this._slots.find((slot) => !taken.has(slot));
  }

  /**
   * Last path segment, falling back to letters at a root. Disambiguation is
   * append-only: numbering is assigned once and survivors are never renumbered
   * when a duplicate closes, because renaming a panel the user is looking at is
   * worse than a gap in the sequence.
   */
  private _name(path: string): string {
    const segment = path.split("/").filter(Boolean).pop();
    const base = segment ?? this._nextLetter();
    const used = new Set([...this._panels.values()].map((p) => p.name));
    if (!used.has(base)) return base;
    for (let n = 2; ; n++) {
      const candidate = `${base} (${n})`;
      if (!used.has(candidate)) return candidate;
    }
  }

  private _nextLetter(): string {
    const used = new Set([...this._panels.values()].map((p) => p.name));
    for (let i = 0; i < 26; i++) {
      const letter = String.fromCharCode(65 + i);
      if (!used.has(letter)) return letter;
    }
    return `Panel ${this._panels.size + 1}`;
  }
}
