import type { Commands } from "@statewalker/shared-commands";
import { newRegistry } from "@statewalker/shared-registry";
import {
  type AppContext,
  atLeast,
  getCommands,
  getSlots,
  type LogRecord,
  loggerBackendsSlot,
  panelsSlot,
} from "@sys";
import { todosSummary } from "@todo/core";
import { LoggerBackendModel } from "./backend-model.js";
import { InspectorModel } from "./inspector-model.js";
import { logInspectorKind, statsOverviewKind } from "./models.js";
import { StatsModel } from "./stats-model.js";

const TIMELINE_LENGTH = 12;
const INSPECTOR_LIMIT = 200;

export interface StatsControllerOptions {
  now?: () => number;
  /** How often the timeline rolls forward with time. */
  tickMs?: number;
}

/**
 * Publishes a logger backend model, and turns what arrives in it into two view
 * models: statistics (placement side) and the log inspector (placement bottom).
 * Deriving statistics from logs is a demo convenience, not the recommended way
 * for controllers to share facts.
 */
export class StatsController {
  readonly backend = new LoggerBackendModel();
  readonly stats = new StatsModel();
  readonly inspector = new InspectorModel();
  private readonly _registry = newRegistry();
  private _disposed = false;
  private _lastSeq = 0;
  private readonly _counts = { created: 0, closed: 0, reopened: 0, removed: 0, removedOpen: 0 };

  constructor(private readonly _options: StatsControllerOptions = {}) {}

  activate(ctx: AppContext): void {
    const [register] = this._registry;
    const slots = getSlots(ctx);
    const commands = getCommands(ctx);
    register(() => {
      this.backend.dispose();
      this.stats.dispose();
      this.inspector.dispose();
    });
    register(
      slots.register(panelsSlot, "stats:overview", {
        kind: statsOverviewKind,
        title: "Statistics",
        placement: "side",
        model: this.stats.view,
      }),
    );
    register(
      slots.register(panelsSlot, "logs:inspector", {
        kind: logInspectorKind,
        title: "Log",
        placement: "bottom",
        model: this.inspector.view,
      }),
    );
    register(this.backend.onRecordsUpdate(() => this._derive()));
    register(this.stats.control.onBucketUpdate(() => this._deriveTimeline()));
    register(this.inspector.control.onFilterUpdate(() => this._deriveEntries()));
    const timer = setInterval(() => this._deriveTimeline(), this._options.tickMs ?? 1000);
    register(() => clearInterval(timer));
    // Registered last, so it is withdrawn first: no record arrives into a disposing controller.
    register(slots.provide(loggerBackendsSlot, this.backend.sink));
    void this._seedBaseline(commands);
  }

  async dispose(): Promise<void> {
    this._disposed = true;
    const [, cleanup] = this._registry;
    await cleanup();
  }

  private async _seedBaseline(commands: Commands): Promise<void> {
    try {
      const { total, done } = await commands.call(todosSummary, {}).promise;
      if (this._disposed) return;
      this.stats.control.publishBaseline({ status: "known", total, done });
    } catch (error) {
      if (this._disposed) return;
      this.stats.control.publishBaseline({
        status: "unknown",
        reason: error instanceof Error ? error.message : String(error),
      });
    }
    this._publishTotals();
  }

  private _derive(): void {
    if (this._disposed) return;
    for (const r of this.backend.getRecords()) {
      if (r.seq <= this._lastSeq) continue;
      this._lastSeq = r.seq;
      this._count(r);
    }
    this._publishTotals();
    this._deriveTimeline();
    this._deriveEntries();
  }

  private _count(r: LogRecord): void {
    const [event, data] = r.args as [unknown, Record<string, unknown> | undefined];
    const c = this._counts;
    if (event === "todos:created") c.created++;
    else if (event === "todos:closed") c.closed++;
    else if (event === "todos:reopened") c.reopened++;
    else if (event === "todos:removed") {
      c.removed++;
      if (data?.done !== true) c.removedOpen++;
    } else if (event === "todos:cleared") c.removed += Number(data?.count ?? 0);
  }

  private _publishTotals(): void {
    if (this._disposed) return;
    const b = this.stats.view.getBaseline();
    const c = this._counts;
    const open =
      b.status === "known"
        ? b.total - b.done + c.created + c.reopened - c.closed - c.removedOpen
        : undefined;
    this.stats.control.publishTotals({
      created: c.created,
      closed: c.closed,
      reopened: c.reopened,
      removed: c.removed,
      open,
    });
  }

  private _deriveTimeline(): void {
    if (this._disposed) return;
    const size = this.stats.control.getBucket();
    const now = (this._options.now ?? Date.now)();
    const end = Math.floor(now / size) * size + size;
    const start = end - TIMELINE_LENGTH * size;
    const buckets = Array.from({ length: TIMELINE_LENGTH }, (_, i) => ({
      start: start + i * size,
      created: 0,
      closed: 0,
    }));
    for (const r of this.backend.getRecords()) {
      if (r.at < start || r.at >= end) continue;
      const bucket = buckets[Math.floor((r.at - start) / size)];
      if (r.args[0] === "todos:created") bucket.created++;
      else if (r.args[0] === "todos:closed") bucket.closed++;
    }
    this.stats.control.publishTimeline(buckets);
  }

  private _deriveEntries(): void {
    if (this._disposed) return;
    const { level, module } = this.inspector.control.getFilter();
    const records = this.backend.getRecords();
    const modules = [
      ...new Set(
        records.map((r) => r.metadata.module).filter((m): m is string => typeof m === "string"),
      ),
    ].sort();
    const entries = records
      .filter((r) => atLeast(r.level, level) && (module === "all" || r.metadata.module === module))
      .slice(-INSPECTOR_LIMIT)
      .reverse();
    this.inspector.control.publishModules(modules);
    this.inspector.control.publishEntries(entries);
    const last = records[records.length - 1];
    if (last) this.inspector.control.publishDropped(last.dropped);
  }
}
