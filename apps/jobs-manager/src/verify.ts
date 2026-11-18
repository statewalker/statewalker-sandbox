import type { JobMessage, JobStatus, Json } from "./types.ts";

/** What a finished job is expected to have produced. Every field is optional. */
export type JobExpectations = {
  /** Final status. */
  status?: JobStatus;
  /** Number of result messages (stdout lines). */
  count?: number;
  /** Each pattern must match at least one result message (subset match, see `matches`). */
  contains?: Json[];
  /** Pattern the last result message must match. */
  last?: Json;
  /** The result messages, in order, each matching the pattern at the same position. */
  expect?: Json[];
};

export type VerifyResult = { ok: boolean; failures: string[] };

/** The payloads of a job's result messages (its stdout lines), in order. */
export function results(messages: JobMessage[]): Json[] {
  return messages.flatMap((m) => ("message" in m && m.message !== undefined ? [m.message] : []));
}

/** Checks a job's recorded messages against expectations; each failed expectation is named. */
export function verifyJob(messages: JobMessage[], expected: JobExpectations): VerifyResult {
  const failures: string[] = [];
  const out = results(messages);
  const status = messages.at(-1)?.status;
  const show = (v: unknown) => JSON.stringify(v);

  if (expected.status !== undefined && status !== expected.status) {
    failures.push(`status: expected ${expected.status}, got ${status}`);
  }
  if (expected.count !== undefined && out.length !== expected.count) {
    failures.push(`count: expected ${expected.count} result messages, got ${out.length}`);
  }
  for (const pattern of expected.contains ?? []) {
    if (!out.some((value) => matches(value, pattern))) {
      failures.push(`contains: no result message matches ${show(pattern)}`);
    }
  }
  if (expected.last !== undefined) {
    const last = out.at(-1);
    if (last === undefined || !matches(last, expected.last)) {
      failures.push(`last: expected ${show(expected.last)}, got ${show(last)}`);
    }
  }
  if (expected.expect !== undefined) {
    if (out.length !== expected.expect.length) {
      failures.push(
        `expect: expected ${expected.expect.length} result messages, got ${out.length}`,
      );
    } else {
      expected.expect.forEach((pattern, i) => {
        if (!matches(out[i] as Json, pattern)) {
          failures.push(`expect: message ${i + 1} is ${show(out[i])}, expected ${show(pattern)}`);
        }
      });
    }
  }
  return { ok: failures.length === 0, failures };
}

/**
 * Structural subset match: an object pattern matches when each of its keys matches; an array
 * pattern matches when each of its elements matches some element of the value; scalars must be
 * equal (no type coercion).
 */
export function matches(value: Json, pattern: Json): boolean {
  if (Array.isArray(pattern)) {
    return Array.isArray(value) && pattern.every((p) => value.some((v) => matches(v, p)));
  }
  if (pattern !== null && typeof pattern === "object") {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
    return Object.entries(pattern).every(
      ([key, p]) => Object.hasOwn(value, key) && matches(value[key] as Json, p),
    );
  }
  return value === pattern;
}
