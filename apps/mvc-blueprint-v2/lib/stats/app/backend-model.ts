import type { LogRecord, LoggerBackend } from "@sys";
import { ModelBase } from "./model-base.js";

/**
 * A logger backend that is also a model: `sink` goes to `sys:logger-backends`
 * (the logs controller sees only `write`); the stats controller observes the
 * records. Keeps the last `capacity` records.
 */
export class LoggerBackendModel extends ModelBase {
  private _records: readonly LogRecord[] = Object.freeze([]);
  readonly sink: LoggerBackend = Object.freeze({ write: (record: LogRecord) => this.write(record) });
  readonly onRecordsUpdate = this.channel(() => this._records);

  constructor(private readonly _capacity = 500) {
    super();
  }

  getRecords(): readonly LogRecord[] {
    return this._records;
  }

  write(record: LogRecord): void {
    this.commit(() => {
      const next = [...this._records, record];
      this._records = Object.freeze(next.length > this._capacity ? next.slice(next.length - this._capacity) : next);
      return true;
    });
  }
}
