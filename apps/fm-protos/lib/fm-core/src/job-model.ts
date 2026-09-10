import { BaseClass } from "@statewalker/shared-baseclass";

export type JobStatus = "running" | "done" | "cancelled" | "failed";

/**
 * Progress is STATE, held in a model the view reflects — never a stream of
 * progress commands. The model is passed live as a command payload.
 */
export class JobModel extends BaseClass {
  status: JobStatus = "running";
  operation: "copy" | "move" | "delete" = "copy";
  total = 0;
  completed = 0;
  error?: string;
  readonly skipped: string[] = [];

  /** Underscore-prefixed: dropped by toJSON, invisible to the view. */
  private _abort = new AbortController();
  private _resolveDone!: () => void;
  readonly done: Promise<void>;

  constructor(readonly id: string) {
    super();
    this.done = new Promise<void>((resolve) => {
      this._resolveDone = resolve;
    });
  }

  get signal(): AbortSignal {
    return this._abort.signal;
  }

  cancel(): void {
    this._abort.abort();
  }

  /** A cancelled job reports a precise boundary, not a vague failure. */
  boundary(): string {
    const verb = { move: "moved", delete: "deleted", copy: "copied" }[this.operation];
    const tail = this.operation === "move" ? ", source retains the rest" : "";
    return `${verb} ${this.completed} of ${this.total}${tail}`;
  }

  private readonly _cleanups: (() => void)[] = [];

  /**
   * Registered by whoever holds resources on the job's behalf. Cleanups run
   * BEFORE `done` resolves, so "the job finished" implies "its storages are
   * released" — otherwise an observer that re-acquires on completion races the
   * release and sees an instance flicker.
   */
  onCleanup(fn: () => void): void {
    this._cleanups.push(fn);
  }

  settle(status: JobStatus, error?: string): void {
    if (this.status !== "running") return;
    this.status = status;
    this.error = error;
    for (const fn of this._cleanups.splice(0)) fn();
    this.notify();
    this._resolveDone();
  }
}
