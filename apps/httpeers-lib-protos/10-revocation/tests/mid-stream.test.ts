/**
 * 10 — Does a revocation reach a stream that is already open?
 *
 * Rung 09 left a hole and named it: a duplex is authorised ONCE, at open. The
 * fetch path re-verifies on every request, so a revoked member is refused
 * within one heartbeat. A stream has no second request to check — so unless
 * something interrupts it, a member removed by the hub keeps talking for as
 * long as it likes. An A2UI session lasts minutes; a tunnel lasts hours.
 *
 * RED/GREEN. `revocation-guard.ts` did not exist when this file was written.
 * Claim 1 below is the hole, written to FAIL against an unguarded mount, and
 * the guard is what turns it green. Claims 2-4 are the properties the guard
 * must not break while doing it.
 *
 * No libp2p here. The directive is that access must validate with no libp2p
 * involvement, so the whole rung runs over in-process streams: the guard is
 * transport-independent or it is not the right seam.
 */

import { describe, expect, it } from "vitest";
import {
  createRevocations,
  guardStream,
  type Revocations,
  StreamRevoked,
} from "../src/revocation-guard.js";

const te = new TextEncoder();
const td = new TextDecoder();

/** A long-lived server: echoes whatever it is sent, forever, like a chat session. */
async function* chat(input: AsyncIterable<Uint8Array>): AsyncGenerator<Uint8Array> {
  for await (const chunk of input) yield te.encode(`re:${td.decode(chunk)}`);
}

/** A hand-driven input that stays open, so the stream is genuinely long-lived. */
function openInput() {
  const queue: Uint8Array[] = [];
  let wake: (() => void) | null = null;
  let closed = false;
  return {
    push(value: string) {
      queue.push(te.encode(value));
      const w = wake;
      wake = null;
      w?.();
    },
    close() {
      closed = true;
      const w = wake;
      wake = null;
      w?.();
    },
    async *iter(): AsyncGenerator<Uint8Array> {
      for (;;) {
        const next = queue.shift();
        if (next != null) {
          yield next;
          continue;
        }
        if (closed) return;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    },
  };
}

const ALICE = "12D3KooWPbzaA61nmJyktyUaszpxftMLqrCh7Yd1UvJ9ZuQJYnBZ";
const BOB = "12D3KooWEHUcCvsmTLLoQG28Y2PDkUfddP1WmdSKwY1sSxfANcxR";

describe("10 — revocation reaches an open stream", () => {
  it("CLAIM 1 — a member revoked mid-stream stops being served", async () => {
    const revocations: Revocations = createRevocations();
    const input = openInput();

    const guarded = guardStream(chat, {
      peerId: ALICE,
      revocations,
      // Checked on every chunk AND on an explicit revocation signal; the
      // interval is the backstop for a stream that is silent in both
      // directions.
      pollMs: 20,
    });

    const out = guarded(input.iter())[Symbol.asyncIterator]();

    input.push("before");
    const first = await out.next();
    expect(td.decode(first.value)).toBe("re:before");

    // The hub removes the member. In the real system this is `hub.remove()`
    // bumping the same live registry the access layer reads.
    revocations.revoke(ALICE);

    // THE HOLE: without a guard the stream simply carries on.
    input.push("after");
    await expect(out.next()).rejects.toBeInstanceOf(StreamRevoked);
  }, 20_000);

  it("CLAIM 2 — a stream that is IDLE in both directions is still interrupted", async () => {
    // The nastier case: a tunnel that has gone quiet. Nothing arrives to
    // trigger a per-chunk check, so only a timer can notice.
    const revocations = createRevocations();
    const input = openInput();
    const guarded = guardStream(chat, { peerId: ALICE, revocations, pollMs: 20 });
    const out = guarded(input.iter())[Symbol.asyncIterator]();

    const pending = out.next();
    revocations.revoke(ALICE);
    await expect(pending).rejects.toBeInstanceOf(StreamRevoked);
  }, 20_000);

  it("CLAIM 3 — revoking someone else does not disturb this stream", async () => {
    const revocations = createRevocations();
    const input = openInput();
    const guarded = guardStream(chat, { peerId: ALICE, revocations, pollMs: 20 });
    const out = guarded(input.iter())[Symbol.asyncIterator]();

    revocations.revoke(BOB);
    input.push("still here");
    const got = await out.next();
    expect(td.decode(got.value)).toBe("re:still here");
    await out.return?.(undefined);
  }, 20_000);

  it("CLAIM 4 — the handler's own cleanup runs when a revocation cuts the stream", async () => {
    // A revocation must not leak whatever the handler was holding: its
    // `finally` has to run, exactly as it does for an ordinary cancellation.
    const revocations = createRevocations();
    const input = openInput();
    let unwound = false;

    const holder = async function* (source: AsyncIterable<Uint8Array>): AsyncGenerator<Uint8Array> {
      try {
        for await (const chunk of source) yield chunk;
      } finally {
        unwound = true;
      }
    };

    const guarded = guardStream(holder, { peerId: ALICE, revocations, pollMs: 20 });
    const out = guarded(input.iter())[Symbol.asyncIterator]();
    input.push("x");
    await out.next();

    revocations.revoke(ALICE);
    await expect(out.next()).rejects.toBeInstanceOf(StreamRevoked);
    expect(unwound).toBe(true);
  }, 20_000);
});
