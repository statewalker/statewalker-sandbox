import { describe, expect, it } from "vitest";
import { describeStatus, parseHeaders, streamInto } from "../src/browser/request-console.js";

describe("parseHeaders", () => {
  it("reads one Name: value per line", () => {
    expect(parseHeaders("x-trace: abc\naccept: application/json")).toEqual({
      "x-trace": "abc", accept: "application/json",
    });
  });

  // A bearer token contains no colon, but a URL-valued header does; only the
  // FIRST colon separates name from value.
  it("keeps colons inside the value", () => {
    expect(parseHeaders("x-origin: https://a.example:8443")).toEqual({ "x-origin": "https://a.example:8443" });
  });

  it("ignores blank lines, lines without a colon, and lines with no name", () => {
    expect(parseHeaders("\n  \nnot a header\n: orphan value\nx-ok: 1")).toEqual({ "x-ok": "1" });
  });
});

describe("describeStatus", () => {
  it("names the status and content type", () => {
    const r = new Response("", { status: 200, headers: { "content-type": "application/json" } });
    expect(describeStatus(r)).toBe("200 · application/json");
  });

  // The proxy's OWN answers carry this marker, so a 404 the proxy produced is
  // never read as a 404 the upstream sent -- different problems, different fixes.
  it("surfaces the proxy's own marker when present", () => {
    const r = new Response("", { status: 404, headers: { "x-httpeers-proxy": "no-route" } });
    expect(describeStatus(r)).toContain("x-httpeers-proxy: no-route");
  });
});

describe("streamInto", () => {
  it("writes every chunk as it arrives and reports how many there were", async () => {
    const enc = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(enc.encode("one ")); c.enqueue(enc.encode("two ")); c.enqueue(enc.encode("three")); c.close(); },
    });
    const seen: string[] = [];
    const stats = await streamInto(new Response(body), (text) => seen.push(text));
    expect(seen.join("")).toBe("one two three");
    expect(stats.chunks).toBe(3);
  });

  // THE MEASUREMENT THAT MAKES STREAMING FALSIFIABLE. If anything upstream
  // buffered, the first chunk arrives when the last does and the two times
  // collapse together; streaming keeps them apart.
  it("records first-chunk and total time separately", async () => {
    const enc = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      async start(c) {
        c.enqueue(enc.encode("a"));
        await new Promise((r) => setTimeout(r, 120));
        c.enqueue(enc.encode("b"));
        c.close();
      },
    });
    const stats = await streamInto(new Response(body), () => {});
    expect(stats.firstChunkMs).not.toBeNull();
    expect(stats.totalMs - (stats.firstChunkMs ?? 0)).toBeGreaterThanOrEqual(100);
  });

  it("handles a response with no body", async () => {
    const stats = await streamInto(new Response(null, { status: 204 }), () => {});
    expect(stats).toMatchObject({ chunks: 0, firstChunkMs: null });
  });
});
