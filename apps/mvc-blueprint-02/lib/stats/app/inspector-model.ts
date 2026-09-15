import type { LogRecord } from "@sys";
import { shallowEqual } from "@sys";
import { ModelBase } from "./model-base.js";
import type { InspectorControl, InspectorFilter, InspectorView } from "./models.js";

export class InspectorModel extends ModelBase {
  private _entries: readonly LogRecord[] = Object.freeze([]);
  private _filter: InspectorFilter = Object.freeze({ level: "trace", module: "all" });
  private _modules: readonly string[] = Object.freeze([]);
  private _dropped = 0;

  readonly view: InspectorView = Object.freeze({
    getEntries: () => this._entries,
    onEntriesUpdate: this.channel(() => this._entries),
    getFilter: () => this._filter,
    onFilterUpdate: this.channel(() => this._filter),
    setFilter: (patch: Partial<InspectorFilter>) =>
      this.commit(() => {
        const next = {
          level: patch.level ?? this._filter.level,
          module: patch.module ?? this._filter.module,
        };
        if (shallowEqual(next, this._filter)) return false;
        this._filter = Object.freeze(next);
        return true;
      }),
    getModules: () => this._modules,
    onModulesUpdate: this.channel(() => this._modules),
    getDropped: () => this._dropped,
    onDroppedUpdate: this.channel(() => this._dropped),
  });

  readonly control: InspectorControl = Object.freeze({
    onFilterUpdate: this.channel(() => this._filter),
    getFilter: () => this._filter,
    publishEntries: (entries: readonly LogRecord[]) =>
      this.commit(() => {
        if (shallowEqual(entries, this._entries)) return false;
        this._entries = Object.freeze([...entries]);
        return true;
      }),
    publishModules: (modules: readonly string[]) =>
      this.commit(() => {
        if (shallowEqual(modules, this._modules)) return false;
        this._modules = Object.freeze([...modules]);
        return true;
      }),
    publishDropped: (dropped: number) =>
      this.commit(() => {
        if (dropped === this._dropped) return false;
        this._dropped = dropped;
        return true;
      }),
  });
}
