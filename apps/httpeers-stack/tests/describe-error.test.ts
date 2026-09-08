import { describe, expect, it } from "vitest";
import { describeError } from "../src/browser/describe-error.js";

describe("describeError", () => {
  it("keeps an Error's message", () => {
    expect(describeError(new Error("boom"))).toContain("boom");
  });

  // The reason this module exists. A failed WebSocket rejects with a DOM
  // `Event`, and `String(event)` is "[object Event]" -- which is what a phone
  // reported when it could not reach the relay, telling nobody anything.
  it("unpacks a DOM-style error Event instead of yielding [object Event]", () => {
    const evt = {
      type: "error",
      target: { url: "wss://relay.httpeers.net/", readyState: 3 },
    };
    const out = describeError(evt);
    expect(out).not.toContain("[object");
    expect(out).toContain("error");
    expect(out).toContain("wss://relay.httpeers.net/");
    expect(out).toContain("CLOSED");
  });

  it("names the readyState in words, since the number alone means nothing", () => {
    expect(describeError({ type: "error", target: { readyState: 0 } })).toContain("CONNECTING");
    expect(describeError({ type: "close", target: { readyState: 1 } })).toContain("OPEN");
  });

  it("reports a close event's code and reason when present", () => {
    const out = describeError({ type: "close", code: 1006, reason: "abnormal", target: {} });
    expect(out).toContain("1006");
    expect(out).toContain("abnormal");
  });

  it("falls back to String() for anything else, without throwing", () => {
    expect(describeError("plain string")).toContain("plain string");
    expect(describeError(null)).toBeTruthy();
    expect(describeError(undefined)).toBeTruthy();
  });

  it("survives a target whose properties throw on access", () => {
    const hostile = {
      type: "error",
      get target() {
        throw new Error("nope");
      },
    };
    expect(() => describeError(hostile)).not.toThrow();
  });
});

describe("describeError — cause de-duplication", () => {
  it("does not repeat a cause that describes the same failure", () => {
    const evt = { type: "error", target: { url: "wss://x/", readyState: 3 } };
    const wrapped = Object.assign(new Error(describeError(evt)), { cause: { ...evt } });
    const out = describeError(wrapped);
    expect(out.match(/socket CLOSED/g)?.length).toBe(1);
  });

  it("still shows a cause that adds information", () => {
    const wrapped = Object.assign(new Error("dial failed"), { cause: new Error("DNS refused") });
    expect(describeError(wrapped)).toContain("DNS refused");
  });
});
