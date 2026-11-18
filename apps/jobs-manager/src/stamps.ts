import type { JobTimeStamp } from "./types.ts";

const round = (n: number) => Math.round(n * 1000) / 1000;

/**
 * Wall-clock milliseconds with microsecond fractions, forced strictly above
 * the previous stamp so stamps can serve as message ids within one job.
 */
export function nextStamp(previous: JobTimeStamp = 0): JobTimeStamp {
  const now = round(performance.timeOrigin + performance.now());
  return now > previous ? now : round(previous + 0.001);
}
