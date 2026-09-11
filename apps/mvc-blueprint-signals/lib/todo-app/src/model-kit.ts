import { effect, type Read } from "@todo/signals";

/**
 * The controller's reaction must be subscribed to `input`, never to the outer
 * model it writes — otherwise its own write wakes it and the reaction loops.
 *
 * Two directions, because one is not evidence: a write to `outer` must NOT
 * wake it, and a write to `input` MUST. Asserting only the first also passes
 * for a controller subscribed to nothing at all, which is the shape fm-protos'
 * version accepted (`void input;`).
 */
export async function expectNoSelfWake(steps: {
  reactions: () => number;
  /** A mutator on the OUTER model — what a controller writes. */
  writeOuter: () => void | Promise<void>;
  /** A mutator on the INPUT sub-model — what a view writes. */
  writeInput: () => void | Promise<void>;
}): Promise<void> {
  const before = steps.reactions();
  await steps.writeOuter();
  if (steps.reactions() !== before) {
    throw new Error(
      "controller reacted to its own write: the reaction must be subscribed to " +
        "its input edges, not to the results it writes.",
    );
  }
  await steps.writeInput();
  if (steps.reactions() === before) {
    throw new Error(
      "controller never reacted to `input`: a reaction subscribed to nothing " +
        "satisfies the no-self-wake rule vacuously.",
    );
  }
}

/**
 * A STATE-LATEST edge (spec §4.2): N increments in one tick are ONE action
 * carrying the newest state. Two increments then one write; the controller
 * must act exactly once. Acting twice means it is treating a state-latest edge
 * as an event edge; acting zero times means it compares against a boolean
 * rather than a watermark.
 *
 * NOTE: `expectEveryEdgeHonoured` — the EVENT-edge counterpart, where N
 * increments must produce N actions and the payload rides in a replaced queue —
 * is specified in §4.2 and deliberately NOT built. No app has an honest caller
 * for it until the dock shell; a form holds one draft, so a real user cannot
 * produce two distinct payloads in one tick.
 */
export function expectCoalescedEdge(steps: {
  /** The mutator that raises the edge — NOT a field write (spec §4.8). */
  bump: () => void;
  /** Reads the counter, to prove the mutator actually raised it. */
  read: () => number;
  actions: () => number;
  label?: string;
}): void {
  const field = steps.label ?? "edge";
  const start = steps.actions();
  const from = steps.read();
  steps.bump();
  steps.bump();
  if (steps.read() !== from + 2) {
    throw new Error(
      `${field}: the mutator must raise a monotonic counter — it went ${from} -> ${steps.read()}.`,
    );
  }
  const delta = steps.actions() - start;
  if (delta === 0) {
    throw new Error(
      `${field}: the controller never acted — compare against a handled watermark, not a boolean.`,
    );
  }
  // NOTE: two `bump()` calls each notify, so a controller reconciling
  // synchronously would act twice legitimately. Reconciliation is async (it
  // awaits the store), which is what collapses them into one — that is the
  // property under test, not an accident of the harness.
  if (delta > 1) {
    throw new Error(
      `${field}: the controller must coalesce — two increments in one tick are one ` +
        `action carrying the newest state, but it acted ${delta} times.`,
    );
  }
}

/**
 * A level field holding an array or object must be REPLACED, never mutated. An
 * in-place `push` changes nothing a signal can see: no write reached it, so no
 * effect over the read wakes. Watched through an effect on `read` — at the
 * source — and the watcher is stopped before this returns.
 */
export async function expectReplacedNotMutated<T>(
  read: Read<T>,
  mutate: () => void | Promise<void>,
): Promise<void> {
  let observed = -1; // the effect's first run is the subscription, not a change
  // No effect in this app throws (global constraint): a `read()` failure is
  // caught here, inside the effect, so it cannot escape unguarded and strand
  // `stop` unreturned; it is rethrown below, from the HELPER, once torn down.
  let readError: unknown;
  let readFailed = false;
  const stop = effect(() => {
    try {
      read();
      observed++;
    } catch (error) {
      readFailed = true;
      readError ??= error;
    }
  });
  try {
    await mutate();
  } finally {
    stop();
  }
  if (readFailed) throw readError;
  if (observed <= 0) {
    throw new Error(
      "level field was not observably replaced: an in-place push/splice is " +
        "invisible to every subscriber. Write a new value.",
    );
  }
}
