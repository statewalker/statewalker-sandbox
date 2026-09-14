import type { LoggerLevel } from "@statewalker/shared-logger";
import type { LogRecord } from "@sys";
import { defineViewKind } from "@sys/ui";

/** The stats feature's model interfaces and kinds — the part a UI module may import. */
export type { LogRecord };

export interface StatsTotals {
  readonly created: number;
  readonly closed: number;
  readonly reopened: number;
  readonly removed: number;
  /** Undefined while the baseline is not known. */
  readonly open: number | undefined;
}

export interface TimelineBucket {
  readonly start: number;
  readonly created: number;
  readonly closed: number;
}

export type Baseline =
  | { readonly status: "loading" }
  | { readonly status: "known"; readonly total: number; readonly done: number }
  | { readonly status: "unknown"; readonly reason: string };

export const BUCKET_SIZES = [10_000, 60_000, 300_000] as const;

export interface StatsView {
  getTotals(): StatsTotals;
  onTotalsUpdate(listener: () => void): () => void;
  getTimeline(): readonly TimelineBucket[];
  onTimelineUpdate(listener: () => void): () => void;
  getBucket(): number;
  onBucketUpdate(listener: () => void): () => void;
  getBaseline(): Baseline;
  onBaselineUpdate(listener: () => void): () => void;
  /** A level intent: one of BUCKET_SIZES; anything else is ignored. */
  setBucket(ms: number): void;
}

export interface StatsControl {
  onBucketUpdate(listener: () => void): () => void;
  getBucket(): number;
  publishTotals(totals: StatsTotals): void;
  publishTimeline(buckets: readonly TimelineBucket[]): void;
  publishBaseline(baseline: Baseline): void;
}

export interface InspectorFilter {
  /** Minimum level shown. */
  readonly level: LoggerLevel;
  /** A module name, or "all". */
  readonly module: string;
}

export interface InspectorView {
  getEntries(): readonly LogRecord[];
  onEntriesUpdate(listener: () => void): () => void;
  getFilter(): InspectorFilter;
  onFilterUpdate(listener: () => void): () => void;
  /** A patch: an explicitly undefined field leaves that field unchanged. */
  setFilter(patch: Partial<InspectorFilter>): void;
  getModules(): readonly string[];
  onModulesUpdate(listener: () => void): () => void;
  getDropped(): number;
  onDroppedUpdate(listener: () => void): () => void;
}

export interface InspectorControl {
  onFilterUpdate(listener: () => void): () => void;
  getFilter(): InspectorFilter;
  publishEntries(entries: readonly LogRecord[]): void;
  publishModules(modules: readonly string[]): void;
  publishDropped(dropped: number): void;
}

export const statsOverviewKind = defineViewKind<StatsView>("stats:overview");
export const logInspectorKind = defineViewKind<InspectorView>("logs:inspector");
