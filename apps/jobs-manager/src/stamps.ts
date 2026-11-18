import type { JobTimeStamp } from "./types.ts";

const round = (n: number) => Math.round(n * 1000) / 1000;

/**
 * Wall-clock milliseconds (`Date.now()`), forced strictly above the previous stamp by microsecond
 * steps so stamps can serve as message ids within one job. Not `performance.now()`: that clock
 * runs ahead of `Date.now()` and drifts further while a server runs, so `cleanup(Date.now())`
 * and `--older-than` would miss jobs that had just finished.
 */
export function nextStamp(previous: JobTimeStamp = 0): JobTimeStamp {
  const now = Date.now();
  return now > previous ? now : round(previous + 0.001);
}
