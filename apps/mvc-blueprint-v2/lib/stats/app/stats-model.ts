import { shallowEqual } from "@sys";
import { ModelBase } from "./model-base.js";
import { type Baseline, BUCKET_SIZES, type StatsControl, type StatsTotals, type StatsView, type TimelineBucket } from "./models.js";

const bucketsEqual = (a: readonly TimelineBucket[], b: readonly TimelineBucket[]) =>
  a.length === b.length && a.every((x, i) => shallowEqual(x, b[i]));

export class StatsModel extends ModelBase {
  private _totals: StatsTotals = Object.freeze({ created: 0, closed: 0, reopened: 0, removed: 0, open: undefined });
  private _timeline: readonly TimelineBucket[] = Object.freeze([]);
  private _bucket: number = BUCKET_SIZES[0];
  private _baseline: Baseline = Object.freeze({ status: "loading" });

  readonly view: StatsView = Object.freeze({
    getTotals: () => this._totals,
    onTotalsUpdate: this.channel(() => this._totals),
    getTimeline: () => this._timeline,
    onTimelineUpdate: this.channel(() => this._timeline),
    getBucket: () => this._bucket,
    onBucketUpdate: this.channel(() => this._bucket),
    getBaseline: () => this._baseline,
    onBaselineUpdate: this.channel(() => this._baseline),
    setBucket: (ms: number) =>
      this.commit(() => {
        if (!(BUCKET_SIZES as readonly number[]).includes(ms) || ms === this._bucket) return false;
        this._bucket = ms;
        return true;
      }),
  });

  readonly control: StatsControl = Object.freeze({
    onBucketUpdate: this.channel(() => this._bucket),
    getBucket: () => this._bucket,
    publishTotals: (totals: StatsTotals) =>
      this.commit(() => {
        if (shallowEqual(totals, this._totals)) return false;
        this._totals = Object.freeze({ ...totals });
        return true;
      }),
    publishTimeline: (buckets: readonly TimelineBucket[]) =>
      this.commit(() => {
        if (bucketsEqual(buckets, this._timeline)) return false;
        this._timeline = Object.freeze(buckets.map((b) => Object.freeze({ ...b })));
        return true;
      }),
    publishBaseline: (baseline: Baseline) =>
      this.commit(() => {
        if (shallowEqual(baseline, this._baseline)) return false;
        this._baseline = Object.freeze({ ...baseline });
        return true;
      }),
  });
}
