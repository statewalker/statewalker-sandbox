/**
 * NOT RECOVERED CODE. Written for the 2026-09-09 adoption (MESH-1), by the
 * mutation pass the work order's §5.3 requires. Every test here exists because
 * a specific mutation of the adopted transport SURVIVED the three adopted
 * suites — the id in each name is the mutant it kills. `PROVENANCE.md` carries
 * the full table.
 *
 * The three adopted suites are not touched. A survivor is closed by ADDING a
 * test, never by widening an assertion in a file whose value is that it is
 * byte-identical to the export.
 *
 *   G1  M3   an envelope larger than one wire chunk
 *   G2  M3d  envelope and first body bytes arriving in the SAME wire chunk
 *   G3  M4a  the serving side's HEAD guard, against a handler that always
 *            returns a body
 *   G4  M4b  a HEAD response's body is null, not an empty stream
 *   G3c M4a  the serving side's HEAD guard, observed ON THE WIRE — G3 alone
 *            cannot see it, because the CLIENT's own HEAD arm masks it
 *   G5  M5d  statusText round-trips
 *   G7  M6b  the outbound half of DEFAULT_MAX_STREAMS, on a peer that both
 *            serves and dials — which is what `peer.ts` builds
 *   G8  M15  a zero-length body chunk puts nothing on the wire
 *   G9  —    leading empty chunks do not confuse the envelope scan. This one
 *            kills NOTHING: M14 removes the `byteLength === 0` guard and the
 *            code still behaves identically, because an empty part contributes
 *            zero bytes to the reassembly. G9 pins the tolerance as a contract
 *            anyway; PROVENANCE.md records M14 as an equivalent mutant, not a
 *            gap.
 *   G6  M8   a `send()` that returns false is awaited on `onDrain()` before
 *            the next chunk goes out
 *
 * G1/G3/G4/G5 run over real libp2p, like the suites they extend. G2 and G6
 * drive `wire.ts` directly through a `Stream` double, because no real
 * transport can be made to produce the interleavings they are about — which
 * is precisely why the adopted suites could not reach them.
 */

import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { generateKeyPair } from "@libp2p/crypto/keys";
import { identify } from "@libp2p/identify";
import type { Stream } from "@libp2p/interface";
import { tcp } from "@libp2p/tcp";
import { multiaddr } from "@multiformats/multiaddr";
import { createLibp2p, type Libp2p } from "libp2p";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PROTOCOL, serveWire, wireRemote } from "./transport-wire.js";
import type { ResponseEnvelope } from "./wire.js";
import { readMessage, writeMessage } from "./wire.js";

let server: Libp2p;
let client: Libp2p;
let remote: ReturnType<typeof wireRemote>;

const mk = async (listen: string[]) =>
  createLibp2p({
    privateKey: await generateKeyPair("Ed25519"),
    addresses: { listen },
    transports: [tcp()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    services: { identify: identify() },
  });

beforeAll(async () => {
  server = await mk(["/ip4/127.0.0.1/tcp/0"]);
  client = await mk([]);

  await serveWire(server, async (req) => {
    const url = new URL(req.url);

    // G1: echo back what the server actually reconstructed from the envelope.
    if (url.pathname === "/echo-long") {
      return new Response(
        JSON.stringify({
          padLength: (url.searchParams.get("pad") ?? "").length,
          note: req.headers.get("x-pad")?.length ?? 0,
        }),
        { headers: { "content-type": "application/json" } },
      );
    }

    // G3/G4: a handler that ALWAYS returns a body, whatever the method. The
    // adopted suites' /head handler branches on the method itself, so their
    // server never has to honour the transport's own HEAD guard.
    if (url.pathname === "/always-body") {
      return new Response("body-that-must-not-travel", {
        status: 200,
        headers: { "content-length": "25", "x-marker": "present" },
      });
    }

    // G5: a status line whose reason phrase is not the one the status implies.
    if (url.pathname === "/reason") {
      return new Response("ok", { status: 418, statusText: "Teapot Reporting For Duty" });
    }

    return new Response("not found", { status: 404 });
  });

  await client.dial(multiaddr(server.getMultiaddrs()[0].toString()));
  remote = wireRemote(client);
}, 30_000);

afterAll(async () => {
  await client?.stop();
  await server?.stop();
});

const target = () => server.peerId.toString();

describe("envelope framing beyond one wire chunk", () => {
  it("G1 (kills M3): an envelope larger than one wire chunk is reassembled", async () => {
    // Every envelope in the adopted suites fits in a single libp2p chunk, so
    // `readMessage`'s accumulation loop only ever ran ONE iteration and its
    // `parts.push(chunk)` arm was never taken. 512 KB of url plus 512 KB of
    // header forces the scan across many chunks before the delimiter appears.
    const pad = "a".repeat(512 * 1024);
    const headerPad = "b".repeat(512 * 1024);
    const res = await remote(
      target(),
      new Request(`http://peer/echo-long?pad=${pad}`, { headers: { "x-pad": headerPad } }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { padLength: number; note: number };
    expect(body.padLength).toBe(pad.length);
    expect(body.note).toBe(headerPad.length);
  }, 30_000);

  it("G2 (kills M3d): body bytes sharing the envelope's chunk are not lost", async () => {
    // libp2p happens to deliver `writeMessage`'s envelope `send()` and its
    // body `send()`s as separate chunks, so `readMessage`'s `tail` arm — the
    // bytes that followed the delimiter INSIDE the envelope's own chunk — is
    // never taken over a real connection. Nothing in the wire format promises
    // that framing, so the arm is real; it just needs a stream double to reach.
    const envelope = JSON.stringify({ url: "http://peer/x", method: "POST", headers: [] });
    const one = new TextEncoder().encode(`${envelope}\nHELLO`);
    const two = new TextEncoder().encode("-WORLD");

    const { envelope: got, body } = await readMessage<{ url: string }>(streamReading([one, two]));
    expect(got.url).toBe("http://peer/x");
    expect(await drain(body)).toBe("HELLO-WORLD");
  });
});

describe("the HEAD guard, on both sides", () => {
  it("G3 (kills M4a): the serving side sends no body for HEAD, whatever the handler returns", async () => {
    const res = await remote(target(), new Request("http://peer/always-body", { method: "HEAD" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("x-marker")).toBe("present");
    expect(res.headers.get("content-length")).toBe("25");
    expect(await res.text()).toBe("");
  });

  it("G4 (kills M4b): a HEAD response's body is null, not an empty stream", async () => {
    // B2 asserts `await res.text()` is "", which an empty ReadableStream also
    // satisfies — so B2 alone cannot tell the client-side HEAD arm from its
    // absence. `body === null` can.
    const res = await remote(target(), new Request("http://peer/always-body", { method: "HEAD" }));
    expect(res.body).toBeNull();
  });

  it("G3b: the same handler DOES send its body for GET", async () => {
    // The other side of the pair: G3 must fail because HEAD was honoured, not
    // because the route is broken for everyone.
    const res = await remote(target(), new Request("http://peer/always-body"));
    expect(await res.text()).toBe("body-that-must-not-travel");
  });
});

describe("the serving side, observed on the wire", () => {
  // `remote()` cannot see this: the client applies its OWN HEAD rule to
  // whatever comes back, so a server that wrongly puts a body on the wire is
  // indistinguishable from one that does not. Reading the stream directly is
  // the only way to assert about the SERVER's half of the pair.
  const rawCall = async (method: string, path: string) => {
    const stream = (await (
      client as unknown as {
        dialProtocol: (a: unknown, p: string, o: unknown) => Promise<Stream>;
      }
    ).dialProtocol(multiaddr(`/p2p/${target()}`), PROTOCOL, {
      runOnLimitedConnection: true,
    })) as Stream;
    await writeMessage(stream, { url: `http://peer${path}`, method, headers: [] }, null);
    const { envelope, body } = await readMessage<ResponseEnvelope>(stream);
    return { envelope, text: await drain(body) };
  };

  it("G3c (kills M4a): no body bytes reach the wire for HEAD", async () => {
    const { envelope, text } = await rawCall("HEAD", "/always-body");
    expect(envelope.status).toBe(200);
    expect(envelope.headers).toContainEqual(["x-marker", "present"]);
    expect(text).toBe("");
  });

  it("G3d: the same route DOES put its body on the wire for GET", async () => {
    // The other side of the pair, again at wire level: G3c must be about HEAD,
    // not about a route that never writes anything.
    const { text } = await rawCall("GET", "/always-body");
    expect(text).toBe("body-that-must-not-travel");
  });
});

describe("the response line", () => {
  it("G5 (kills M5d): statusText round-trips", async () => {
    const res = await remote(target(), new Request("http://peer/reason"));
    expect(res.status).toBe(418);
    expect(res.statusText).toBe("Teapot Reporting For Duty");
    expect(await res.text()).toBe("ok");
  });
});

describe("a peer that both serves and dials", () => {
  // Measured on libp2p 3.3.8 while closing this gap: a node that DIALS
  // `/httpeers/1.0.0` without having REGISTERED it is capped at libp2p's own
  // default of 64 concurrent outbound streams (the 65th rejects with
  // `TooManyOutboundProtocolStreamsError`); a node that has called
  // `serveWire` reaches 400 without complaint, because `node.handle`'s
  // `maxOutboundStreams: DEFAULT_MAX_STREAMS` is where libp2p reads that
  // number from.
  //
  // Every client in the three adopted suites calls `wireRemote` WITHOUT
  // `serveWire`. So B5's 40 concurrent calls sat under libp2p's default 64
  // and never touched `DEFAULT_MAX_STREAMS`'s outbound half at all — B5
  // proves the INBOUND cap (reverting it to 32 does fail B5) and nothing
  // else. `peer.ts` calls both, so a real peer is the shape below.
  let alice: Libp2p;
  let bob: Libp2p;
  let aliceRemote: ReturnType<typeof wireRemote>;

  beforeAll(async () => {
    alice = await mk([]);
    bob = await mk(["/ip4/127.0.0.1/tcp/0"]);
    const slow = async (req: Request) => {
      await tick(100);
      return new Response(new URL(req.url).searchParams.get("n") ?? "?");
    };
    await serveWire(alice, slow); // <- the registration M6b mutates
    await serveWire(bob, slow);
    await alice.dial(multiaddr(bob.getMultiaddrs()[0].toString()));
    aliceRemote = wireRemote(alice);
    // One warm call before the burst. A cold process dialing ~100 streams at
    // once is flaky for reasons that have nothing to do with the cap under
    // test (the very first burst in a fresh process fails wholesale); the
    // adopted suites get this warm-up for free from the tests that run ahead
    // of B5 in their own file.
    await aliceRemote(bob.peerId.toString(), new Request("http://peer/slow?n=warm"));
  }, 30_000);

  afterAll(async () => {
    await alice?.stop();
    await bob?.stop();
  });

  it("G7 (kills M6b): 100 concurrent OUTBOUND streams from a serving peer", async () => {
    // 100 > 64, so this passes only if `serveWire`'s maxOutboundStreams is in
    // force on the DIALING side. Reduce it and the burst rejects.
    const results = await Promise.all(
      Array.from({ length: 100 }, async (_, i) => {
        const res = await aliceRemote(
          bob.peerId.toString(),
          new Request(`http://peer/slow?n=${i}`),
        );
        return res.text();
      }),
    );
    expect(results).toEqual(Array.from({ length: 100 }, (_, i) => String(i)));
  }, 30_000);
});

describe("zero-length chunks", () => {
  it("G8 (kills M15): an empty body chunk puts nothing on the wire", async () => {
    const sent: number[] = [];
    const stream = {
      send(bytes: Uint8Array) {
        sent.push(bytes.byteLength);
        return true;
      },
      onDrain: async () => {},
      close: async () => {},
    } as unknown as Stream;

    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode("a"));
        c.enqueue(new Uint8Array(0)); // a producer that yields nothing
        c.enqueue(new TextEncoder().encode("b"));
        c.close();
      },
    });

    await writeMessage(stream, { url: "http://peer/x", method: "POST", headers: [] }, body);
    // Envelope, "a", "b" -- and no fourth, empty frame for the empty chunk.
    expect(sent.slice(1)).toEqual([1, 1]);
  });

  it("G9: leading empty chunks do not confuse the envelope scan", async () => {
    // Documents the tolerance; does NOT kill M14 -- see the header comment.
    const envelope = JSON.stringify({ url: "http://peer/x", method: "GET", headers: [] });
    const bytes = new TextEncoder().encode(`${envelope}\n`);
    const { envelope: got, body } = await readMessage<{ url: string }>(
      streamReading([
        new Uint8Array(0),
        bytes.subarray(0, 10),
        new Uint8Array(0),
        bytes.subarray(10),
      ]),
    );
    expect(got.url).toBe("http://peer/x");
    expect(await drain(body)).toBe("");
  });
});

describe("backpressure", () => {
  it("G6 (kills M8): a full send is awaited on onDrain before the next chunk", async () => {
    // R2 pushes 8 MB through a relay and asserts the BYTES all arrive, which a
    // transport that ignores `send()`'s return value and buffers without bound
    // also satisfies. What `send(): false` -> `await onDrain()` actually
    // promises is that no further bytes are written until the peer drains —
    // observable only by holding `onDrain` open and watching the writer stop.
    const sent: string[] = [];
    let releaseDrain: (() => void) | undefined;
    let full = true;

    const stream = {
      send(bytes: Uint8Array) {
        sent.push(new TextDecoder().decode(bytes));
        // The envelope goes out, then the stream reports itself full.
        if (sent.length >= 1 && full) return false;
        return true;
      },
      onDrain: () =>
        new Promise<void>((resolve) => {
          releaseDrain = () => {
            full = false;
            resolve();
          };
        }),
      close: async () => {},
    } as unknown as Stream;

    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode("first"));
        c.enqueue(new TextEncoder().encode("second"));
        c.close();
      },
    });

    const done = writeMessage(stream, { url: "http://peer/x", method: "POST", headers: [] }, body);

    // Give the writer every chance to run ahead of the drain it is owed.
    await tick(10);
    expect(sent.length).toBe(1); // the envelope, and then it stopped
    expect(releaseDrain).toBeTypeOf("function");

    releaseDrain?.();
    await done;
    expect(sent.slice(1)).toEqual(["first", "second"]);
  });
});

// ---------------------------------------------------------------------------

/** The read half of a `Stream`: yields exactly the chunks it was given. */
function streamReading(chunks: Uint8Array[]): Stream {
  return {
    [Symbol.asyncIterator]: async function* () {
      for (const c of chunks) yield c;
    },
  } as unknown as Stream;
}

async function drain(body: ReadableStream<Uint8Array>): Promise<string> {
  const reader = body.getReader();
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (value != null) out += new TextDecoder().decode(value);
    if (done) break;
  }
  return out;
}

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));
