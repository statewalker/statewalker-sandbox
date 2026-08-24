/**
 * T5: `/health` and the discovery document, served by real relays on real
 * ports and fetched over real HTTP.
 *
 * THE DISCOVERY DOCUMENT'S ONLY JOB IS TO NOT GO STALE, so the assertions
 * that matter are the ones tying its contents to the running node rather than
 * to whatever was configured: the peerId is the key the relay actually loaded,
 * and `addrs` is what libp2p advertises after boot -- which, when
 * `RELAY_ANNOUNCE` is set, is NOT what the relay binds. A test that only
 * checked the shape would pass against an endpoint returning a snapshot taken
 * at boot, which is the failure this endpoint exists to prevent one layer
 * down.
 */

import { createServer } from "node:net";
import { generateKeyPair, privateKeyToProtobuf } from "@libp2p/crypto/keys";
import { peerIdFromPrivateKey } from "@libp2p/peer-id";
import { afterEach, describe, expect, it } from "vitest";
import { resolveRelayConfig } from "../src/config.js";
import { DISCOVERY_PATH, HEALTH_PATH } from "../src/http.js";
import { type Relay, startRelay, startRelayFromConfig } from "../src/relay.js";

const running: Relay[] = [];

afterEach(async () => {
  while (running.length > 0) {
    await running
      .pop()
      ?.stop()
      .catch(() => {});
  }
});

function track(relay: Relay): Relay {
  running.push(relay);
  return relay;
}

/** A port nothing is listening on, released immediately -- the same shape `relay.test.ts` uses. */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address == null || typeof address === "string") {
        reject(new Error("could not read the probe listener's port"));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

/** True when something is accepting connections on `port`. */
async function portIsBound(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once("error", () => resolve(true));
    probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(false)));
  });
}

async function startWithHttp(init: { announce?: string[] } = {}): Promise<Relay> {
  return track(
    await startRelay({
      port: 0,
      httpPort: 0,
      privateKey: await generateKeyPair("Ed25519"),
      ...init,
    }),
  );
}

const url = (relay: Relay, path: string): string =>
  `http://127.0.0.1:${relay.http?.port ?? 0}${path}`;

describe("GET /health", () => {
  it("answers 200 with a body a platform can log", async () => {
    const relay = await startWithHttp();
    const res = await fetch(url(relay, HEALTH_PATH));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  }, 30_000);
});

describe("GET /.well-known/httpeers-relay.json", () => {
  it("publishes the peerId of the key the relay actually loaded", async () => {
    // Not the key it was configured with in some other sense -- the identity
    // an operator checks did not change across a deploy.
    const key = await generateKeyPair("Ed25519");
    const relay = track(await startRelay({ port: 0, httpPort: 0, privateKey: key }));
    const doc = (await (await fetch(url(relay, DISCOVERY_PATH))).json()) as { peerId: string };
    expect(doc.peerId).toBe(peerIdFromPrivateKey(key).toString());
    expect(doc.peerId).toBe(relay.node.peerId.toString());
  }, 30_000);

  it("publishes the ANNOUNCED addresses, not the bound ones", async () => {
    // THE ASSERTION THIS FILE EXISTS FOR. Behind a reverse proxy the relay
    // binds plain ws on an internal port and peers must dial wss at a public
    // name; a document reporting what it binds would be published, copied, and
    // undialable. `getMultiaddrs()` is the honest source and this proves the
    // endpoint uses it.
    const port = await freePort();
    const key = await generateKeyPair("Ed25519");
    const relayPeerId = peerIdFromPrivateKey(key).toString();
    const relay = track(
      await startRelayFromConfig(
        resolveRelayConfig({
          RELAY_KEY: Buffer.from(privateKeyToProtobuf(key)).toString("base64"),
          RELAY_PORT: String(port),
          RELAY_HTTP_PORT: "0",
          RELAY_ANNOUNCE: `/dns4/relay.example.net/tcp/443/wss`,
        }),
      ),
    );

    const doc = (await (await fetch(url(relay, DISCOVERY_PATH))).json()) as {
      addrs: string[];
      mode: string;
    };
    expect(doc.addrs).toEqual([`/dns4/relay.example.net/tcp/443/wss/p2p/${relayPeerId}`]);
    expect(doc.addrs.some((addr) => addr.includes("0.0.0.0"))).toBe(false);
    expect(doc.mode).toBe("open");
  }, 30_000);

  it("publishes the mode, so a refused peer can tell why", async () => {
    const relay = track(
      await startRelay({
        port: 0,
        httpPort: 0,
        privateKey: await generateKeyPair("Ed25519"),
        mode: "registered",
        networks: [{ name: "listed" }],
      }),
    );
    expect(
      ((await (await fetch(url(relay, DISCOVERY_PATH))).json()) as { mode: string }).mode,
    ).toBe("registered");
  }, 30_000);

  it("is not cacheable -- a proxy holding yesterday's copy is the bug this endpoint removes", async () => {
    const relay = await startWithHttp();
    expect((await fetch(url(relay, DISCOVERY_PATH))).headers.get("cache-control")).toBe("no-store");
  }, 30_000);
});

describe("everything else", () => {
  it("404s an unknown path, and names the two that exist", async () => {
    const relay = await startWithHttp();
    const res = await fetch(url(relay, "/metrics"));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: "not found",
      paths: [HEALTH_PATH, DISCOVERY_PATH],
    });
  }, 30_000);

  it("405s a non-GET on a route that exists, and says what would have worked", async () => {
    const relay = await startWithHttp();
    for (const path of [HEALTH_PATH, DISCOVERY_PATH]) {
      const res = await fetch(url(relay, path), { method: "POST" });
      expect(res.status).toBe(405);
      expect(res.headers.get("allow")).toBe("GET");
    }
  }, 30_000);
});

describe("the surface shuts down with the relay", () => {
  it("releases the port, rather than merely being asked to", async () => {
    // PROVEN, NOT TRUSTED. `server.close()` alone stops accepting and then
    // waits for open connections, and a keep-alive probe from a container
    // platform holds one for as long as it likes -- so a relay asked to stop
    // could keep its port indefinitely and nothing here would notice.
    const port = await freePort();
    const relay = await startRelay({
      port: 0,
      httpPort: port,
      privateKey: await generateKeyPair("Ed25519"),
    });
    expect(relay.http?.port).toBe(port);

    // An answered request first, so there is a real connection in flight's
    // wake rather than a server nothing ever touched.
    expect((await fetch(`http://127.0.0.1:${port}${HEALTH_PATH}`)).status).toBe(200);
    expect(await portIsBound(port)).toBe(true);

    await relay.stop();
    expect(await portIsBound(port)).toBe(false);
  }, 30_000);

  it("a relay started without an http port serves nothing and still stops", async () => {
    // The library case: `apps/httpeers-stack`'s suites boot relays by the
    // dozen and none of them want a second port bound.
    const relay = track(
      await startRelay({ port: 0, privateKey: await generateKeyPair("Ed25519") }),
    );
    expect(relay.http).toBeUndefined();
  }, 30_000);
});
