/**
 * T5: the reservation limits, and the one test that keeps their defaults from
 * quietly becoming this project's opinion.
 *
 * `DEFAULT_RELAY_LIMITS` copies four numbers out of
 * `@libp2p/circuit-relay-v2`'s own constants, because that package exports
 * only `.` and its index re-exports the two protocol codecs and none of these
 * -- a deep import fails `ERR_PACKAGE_PATH_NOT_EXPORTED`. A copy with no check
 * against its source is a copy that drifts on the next upgrade, silently, in
 * the direction of "we are running ceilings nobody chose". So this suite reads
 * that constants file OFF DISK and fails if any of the four moves.
 *
 * It reads rather than imports on purpose: the file is unreachable through the
 * package's `exports` map, and reaching it by module resolution would be the
 * very thing the package has forbidden. A filesystem read of a file whose path
 * is derived from the resolved entry point is honest about what it is doing.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { circuitRelayTransport } from "@libp2p/circuit-relay-v2";
import { generateKeyPair } from "@libp2p/crypto/keys";
import { identify } from "@libp2p/identify";
import { webSockets } from "@libp2p/websockets";
import { multiaddr } from "@multiformats/multiaddr";
import { createLibp2p, type Libp2p } from "libp2p";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_RELAY_LIMITS, RelayConfigError, resolveRelayConfig } from "../src/config.js";
import { startRelay } from "../src/relay.js";
import { announceSubnetwork } from "../src/subnetwork.js";
import { loadRelayKeyForTests, relayKeyForTests } from "./support/keys.js";

beforeAll(async () => await loadRelayKeyForTests());

/** The text of `@libp2p/circuit-relay-v2`'s own `constants.js`, found beside its resolved entry point. */
function circuitRelayConstantsSource(): string {
  const entry = fileURLToPath(import.meta.resolve("@libp2p/circuit-relay-v2"));
  return readFileSync(new URL("./constants.js", `file://${entry}`), "utf8");
}

/** The right-hand side of `export const <name> = <expr>;`, as written. */
function constantExpression(source: string, name: string): string {
  const match = new RegExp(`export const ${name} = ([^;]+);`).exec(source);
  if (match?.[1] == null) {
    throw new Error(
      `${name} is no longer declared in @libp2p/circuit-relay-v2's constants.js -- ` +
        "the upstream shape changed and DEFAULT_RELAY_LIMITS needs re-deriving by hand.",
    );
  }
  return match[1].trim();
}

describe("the shipped limits are circuit-relay-v2's own, not ours", () => {
  // The four expressions as that file writes them, at 4.2.11. Compared as
  // TEXT, not as evaluated numbers: `2 * 60 * minute` changing to `4 * 60 *
  // minute` must fail here even if somebody had also updated our copy, because
  // what is being pinned is "we looked, and this is what it said".
  const expected: Record<string, string> = {
    DEFAULT_MAX_RESERVATION_STORE_SIZE: "15",
    DEFAULT_MAX_RESERVATION_TTL: "2 * 60 * minute",
    DEFAULT_DATA_LIMIT: "BigInt(1 << 17)",
    DEFAULT_DURATION_LIMIT: "2 * minute",
  };

  it("still says what our copy says it said", () => {
    const source = circuitRelayConstantsSource();
    for (const [name, text] of Object.entries(expected)) {
      expect(constantExpression(source, name), `${name} moved upstream`).toBe(text);
    }
  });

  it("and our copy evaluates to the same values", () => {
    // The other half: the text above could match while our transcription of it
    // was wrong. `minute` is 60_000 in that file.
    expect(DEFAULT_RELAY_LIMITS.maxReservations).toBe(15);
    expect(DEFAULT_RELAY_LIMITS.reservationTtlMs).toBe(2 * 60 * 60_000);
    expect(DEFAULT_RELAY_LIMITS.defaultDataLimitBytes).toBe(BigInt(1 << 17));
    expect(DEFAULT_RELAY_LIMITS.defaultDurationLimitMs).toBe(2 * 60_000);
  });

  it("setting nothing changes nothing", () => {
    // The property the whole exercise exists for.
    expect(resolveRelayConfig({ RELAY_KEY: relayKeyForTests() }).limits).toEqual(
      DEFAULT_RELAY_LIMITS,
    );
  });
});

describe("the limits come from the environment", () => {
  const base = (): Record<string, string> => ({ RELAY_KEY: relayKeyForTests() });

  it("reads all four", () => {
    const config = resolveRelayConfig({
      ...base(),
      RELAY_MAX_RESERVATIONS: "512",
      RELAY_RESERVATION_TTL_MS: "60000",
      RELAY_DATA_LIMIT_BYTES: "1048576",
      RELAY_DURATION_LIMIT_MS: "30000",
    });
    expect(config.limits).toEqual({
      maxReservations: 512,
      reservationTtlMs: 60_000,
      defaultDataLimitBytes: 1_048_576n,
      defaultDurationLimitMs: 30_000,
    });
  });

  it("a data limit past Number.MAX_SAFE_INTEGER keeps every digit", () => {
    // The reason this one is a bigint rather than a number: `circuitRelayServer`
    // takes a bigint, and a relay configured in gigabytes must not silently
    // round on the way through this loader.
    const huge = "9007199254740993"; // MAX_SAFE_INTEGER + 2
    const config = resolveRelayConfig({ ...base(), RELAY_DATA_LIMIT_BYTES: huge });
    expect(config.limits.defaultDataLimitBytes).toBe(BigInt(huge));
  });

  for (const [name, value, complaint] of [
    ["RELAY_MAX_RESERVATIONS", "lots", /positive whole number of reservations/],
    ["RELAY_MAX_RESERVATIONS", "0", /positive whole number/],
    ["RELAY_MAX_RESERVATIONS", "-1", /positive whole number/],
    ["RELAY_MAX_RESERVATIONS", "1.5", /positive whole number/],
    ["RELAY_RESERVATION_TTL_MS", "2 hours", /positive whole number of milliseconds/],
    ["RELAY_DURATION_LIMIT_MS", "forever", /positive whole number of milliseconds/],
    ["RELAY_DATA_LIMIT_BYTES", "128KiB", /not a whole number of bytes/],
    ["RELAY_DATA_LIMIT_BYTES", "0", /at least 1 byte/],
  ] as const) {
    it(`refuses ${name}="${value}" rather than ignoring it`, () => {
      // A relay that started with a silently dropped limit would run at a
      // ceiling nobody chose, and the only symptom would arrive much later --
      // as a bill, or as peers being refused -- with nothing pointing here.
      let message = "";
      try {
        resolveRelayConfig({ ...base(), [name]: value });
      } catch (err) {
        expect(err).toBeInstanceOf(RelayConfigError);
        message = (err as Error).message;
      }
      expect(message).toMatch(complaint);
      expect(message).toContain(name);
    });
  }
});

describe("a configured limit actually reaches the server", () => {
  const running: Array<{ stop: () => Promise<void> }> = [];
  afterEach(async () => {
    while (running.length > 0)
      await running
        .pop()
        ?.stop()
        .catch(() => {});
  });

  /** A peer that dials a `ws` relay, announces, and seeks a reservation. */
  async function startPeer(): Promise<Libp2p> {
    const node = await createLibp2p({
      privateKey: await generateKeyPair("Ed25519"),
      addresses: { listen: ["/p2p-circuit"] },
      transports: [webSockets(), circuitRelayTransport()],
      connectionEncrypters: [noise()],
      streamMuxers: [yamux()],
      services: { identify: identify() },
    });
    running.push({ stop: async () => void (await node.stop()) });
    return node;
  }

  async function holdsReservation(node: Libp2p, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (node.getMultiaddrs().some((a) => a.toString().includes("p2p-circuit"))) return true;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return false;
  }

  it("maxReservations=1 admits one peer and refuses the second", async () => {
    // NOT A TEST THAT AN OPTION WAS PASSED -- a test that it BINDS. This
    // version nests the limits under `reservations`, and a flat
    // `{ maxReservations }` is accepted by neither the type nor the runtime:
    // it would look configured and do nothing, which is exactly the failure
    // mode `config.ts` refuses bad input to avoid. Reverting the nesting fails
    // here and nowhere else.
    const relay = await startRelay({
      port: 0,
      privateKey: await generateKeyPair("Ed25519"),
      limits: { ...DEFAULT_RELAY_LIMITS, maxReservations: 1 },
      log: () => {},
    });
    running.push(relay);

    const addr = relay.node
      .getMultiaddrs()
      .map((a) => a.toString())
      .find((a) => a.startsWith("/ip4/127.0.0.1/"));
    if (addr == null) throw new Error("the relay reported no loopback address");

    const first = await startPeer();
    await first.dial(multiaddr(addr));
    await announceSubnetwork(first, relay.node.peerId, "limits-test");
    expect(await holdsReservation(first, 10_000)).toBe(true);

    const second = await startPeer();
    await second.dial(multiaddr(addr));
    await announceSubnetwork(second, relay.node.peerId, "limits-test");
    // The store is full, so this peer is refused -- and libp2p does not retry
    // a refused reservation promptly (ADR-adjacent finding from T4), so a
    // generous wait here is still a wait for something that will not come.
    expect(await holdsReservation(second, 6_000)).toBe(false);
  }, 60_000);
});
