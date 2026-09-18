/**
 * Single writer, R2 style: a stream has exactly one writer (its owner actor — enforced at runtime),
 * and what a view receives has no writer at all — only intents (messages, action dispatch).
 */
import { describe, expect, expectTypeOf, it } from "vitest";
import type { ViewProps } from "../../src/bundles/shell/api/react.js";
import {
  ActorSystem,
  defineStream,
  type StreamReader,
  type ViewPort,
} from "../../src/kernel/index.js";

describe("single writer", () => {
  it("a view gets state + intents, nothing that writes state (type level)", () => {
    expectTypeOf<keyof ViewProps<unknown, unknown>>().toEqualTypeOf<
      "state" | "send" | "dispatch"
    >();
    expectTypeOf<keyof StreamReader>().toEqualTypeOf<"get" | "subscribe">();
    expectTypeOf<keyof ViewPort>().toEqualTypeOf<"get" | "subscribe" | "send">();
  });

  it("a second writer of a stream is refused at runtime; the owner's value stands", () => {
    const system = new ActorSystem({ logSink: () => {} });
    const s = defineStream<number>("x");
    system.spawn("owner", (ctx) => {
      ctx.publish(s, 1);
      return () => {};
    });
    expect(() => system.streams.publish(s, "intruder", 2)).toThrow(/owned by "owner"/);
    expect(system.streams.get(s)).toBe(1);
  });
});
