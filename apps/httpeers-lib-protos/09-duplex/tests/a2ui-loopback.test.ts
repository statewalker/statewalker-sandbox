/**
 * The A2UI adapter, over a LOOPBACK duplex — no transport at all.
 *
 * Written first as a debugging isolation (does the adapter hang, or does the
 * transport?) and kept, because it is also the cheapest possible statement of
 * the isomorphism claim at this altitude: the same adapter, the same codec
 * chain, no network. If this passes and the libp2p version fails, the fault is
 * in the transport; if both fail, it is here.
 */

import {
  decodeJsonl,
  decodeText,
  encodeJsonl,
  encodeText,
  newAsyncGenerator,
} from "@statewalker/webrun-streams";
import { describe, expect, it } from "vitest";

const td = new TextDecoder();
const te = new TextEncoder();

/** An in-process peer: echo each JSONL line back. */
async function* echo(input: AsyncIterable<Uint8Array>): AsyncGenerator<Uint8Array> {
  for await (const chunk of input) {
    const line = td.decode(chunk).trim();
    if (line === "") continue;
    const message = JSON.parse(line) as { hello?: string };
    yield te.encode(`${JSON.stringify({ reply: message.hello })}\n`);
  }
}

describe("09 — the A2UI codec chain, with no transport", () => {
  it("CLAIM 8 — a send() before the first pull is delivered, not dropped and not thrown", async () => {
    const pending: { value: unknown; settle: (taken: boolean) => void }[] = [];
    let wake: (() => void) | null = null;

    const outbound = newAsyncGenerator<unknown>((next) => {
      void (async () => {
        for (;;) {
          const item = pending.shift();
          if (item == null) {
            await new Promise<void>((resolve) => {
              wake = resolve;
            });
            continue;
          }
          const taken = await next(item.value);
          item.settle(taken);
          if (!taken) return;
        }
      })();
    });

    const send = (message: unknown): Promise<boolean> =>
      new Promise<boolean>((settle) => {
        pending.push({ value: message, settle });
        const w = wake;
        wake = null;
        w?.();
      });

    const inbound = decodeJsonl<{ reply?: string }>(
      decodeText(echo(encodeText(encodeJsonl(outbound)))),
    );

    // Nothing has pulled yet — the exact moment an earlier sketch threw.
    void send({ hello: "world" });

    const iterator = inbound[Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(first.value?.reply).toBe("world");
    await iterator.return?.(undefined);
  }, 20_000);
});
