/**
 * T1's "print the peerId, always" and T3's "warn loudly", asserted as text.
 *
 * Both are claims about what an operator sees, and both concern situations
 * that look exactly like success from inside the process. Nothing else in
 * this package fails when they stop being emitted, so they are asserted here
 * rather than trusted.
 */

import { generateKeyPair, privateKeyToProtobuf } from "@libp2p/crypto/keys";
import type { Ed25519PrivateKey } from "@libp2p/interface";
import { peerIdFromPrivateKey } from "@libp2p/peer-id";
import { beforeAll, describe, expect, it } from "vitest";
import {
  DEFAULT_RELAY_HTTP_PORT,
  DEFAULT_RELAY_LIMITS,
  type ResolvedRelayConfig,
} from "../src/config.js";
import { relayStartupReport } from "../src/report.js";

let privateKey: Ed25519PrivateKey;
let peerId: string;

beforeAll(async () => {
  privateKey = await generateKeyPair("Ed25519");
  peerId = peerIdFromPrivateKey(privateKey).toString();
});

function config(overrides: Partial<ResolvedRelayConfig> = {}): ResolvedRelayConfig {
  return {
    privateKey,
    keySource: "RELAY_KEY",
    listen: ["/ip4/0.0.0.0/tcp/9090/ws"],
    announce: [],
    tlsMode: "edge",
    tlsModeExplicit: false,
    mode: "open",
    networks: [],
    networksConfigured: false,
    limits: DEFAULT_RELAY_LIMITS,
    httpPort: DEFAULT_RELAY_HTTP_PORT,
    ...overrides,
  };
}

describe("the peerId is printed at startup, always", () => {
  it("appears in every mode and every key source", () => {
    for (const cfg of [
      config(),
      config({ tlsMode: "edge", tlsModeExplicit: true }),
      config({ tlsMode: "self", tls: { cert: "c", key: "k" }, tlsModeExplicit: true }),
      config({ keySource: "RELAY_KEY_PATH (./.httpeers/relay.key)" }),
      config({ announce: ["/dns4/relay.example.net/tcp/443/wss"] }),
    ]) {
      const { lines } = relayStartupReport(cfg, peerId, ["/ip4/127.0.0.1/tcp/9090/ws"]);
      expect(lines.some((line) => line.includes(peerId))).toBe(true);
    }
  });

  it("names where the key came from, and never prints the key itself", () => {
    const { lines } = relayStartupReport(config(), peerId, []);
    const text = lines.join("\n");
    expect(text).toContain("key from   RELAY_KEY");
    // The report names the SOURCE, never the secret. An operator pastes this
    // block into an issue.
    expect(text).not.toContain(Buffer.from(privateKeyToProtobuf(privateKey)).toString("base64"));
    expect(text).not.toContain(Buffer.from(privateKey.raw).toString("base64"));
  });
});

describe("the startup log states the TLS mode and what it implies", () => {
  it("edge says the relay's own port is unencrypted and must not be exposed", () => {
    const text = relayStartupReport(config({ tlsModeExplicit: true }), peerId, []).lines.join("\n");
    expect(text).toContain("tls mode   edge");
    expect(text).toContain("UNENCRYPTED");
    expect(text).toContain("must not be");
    expect(text).toContain("exposed directly");
  });

  it("self says the relay terminates TLS itself", () => {
    const text = relayStartupReport(
      config({ tlsMode: "self", tls: { cert: "c", key: "k" }, tlsModeExplicit: true }),
      peerId,
      [],
    ).lines.join("\n");
    expect(text).toContain("tls mode   self");
    expect(text).toContain("terminates TLS itself");
  });

  it("a defaulted mode says so, so an operator can tell a choice from an accident", () => {
    const text = relayStartupReport(config({ tlsModeExplicit: false }), peerId, []).lines.join(
      "\n",
    );
    expect(text).toContain("defaulted");
    expect(text).toContain("RELAY_TLS");
  });
});

describe("listen and announce are both reported, because they can now differ", () => {
  it("with no announce configured, it says so rather than leaving a blank", () => {
    const text = relayStartupReport(config(), peerId, []).lines.join("\n");
    expect(text).toContain("listen     /ip4/0.0.0.0/tcp/9090/ws");
    expect(text).toContain("announce   (same as listen");
  });

  it("with an announce configured, both appear and are distinguishable", () => {
    const text = relayStartupReport(
      config({ announce: ["/dns4/relay.example.net/tcp/443/wss"] }),
      peerId,
      [],
    ).lines.join("\n");
    expect(text).toContain("listen     /ip4/0.0.0.0/tcp/9090/ws");
    expect(text).toContain("announce   /dns4/relay.example.net/tcp/443/wss");
  });
});

describe("T3: edge mode announcing a non-TLS address warns loudly", () => {
  it("warns, naming the offending address and the symptom it produces", () => {
    // This misconfiguration presents as browsers on an https origin silently
    // failing to connect -- the mixed-content rule refuses the dial before
    // anything reaches this relay, so its own logs stay clean. The warning is
    // the only place the operator can learn of it.
    const { warnings } = relayStartupReport(
      config({
        tlsModeExplicit: true,
        announce: ["/dns4/relay.example.net/tcp/9090/ws"],
      }),
      peerId,
      [],
    );
    const text = warnings.join("\n");
    expect(text).toContain("WARNING");
    expect(text).toContain("/dns4/relay.example.net/tcp/9090/ws");
    expect(text).toContain("mixed-content");
  });

  it("does not warn when the announced address is wss", () => {
    const { warnings } = relayStartupReport(
      config({ tlsModeExplicit: true, announce: ["/dns4/relay.example.net/tcp/443/wss"] }),
      peerId,
      [],
    );
    expect(warnings).toEqual([]);
  });

  it("does not warn on the expanded /tls/ws spelling of the same thing", () => {
    // multiaddr accepts both `/wss` and `/tls/ws`, and libp2p writes the
    // latter in places. A warning that fired on one spelling of a correct
    // address would be worse than no warning.
    const { warnings } = relayStartupReport(
      config({ tlsModeExplicit: true, announce: ["/dns4/relay.example.net/tcp/443/tls/ws"] }),
      peerId,
      [],
    );
    expect(warnings).toEqual([]);
  });

  it("warns about the plain entries only, when a list mixes them", () => {
    const { warnings } = relayStartupReport(
      config({
        tlsModeExplicit: true,
        announce: ["/dns4/relay.example.net/tcp/443/wss", "/ip4/203.0.113.9/tcp/9090/ws"],
      }),
      peerId,
      [],
    );
    const text = warnings.join("\n");
    expect(text).toContain("/ip4/203.0.113.9/tcp/9090/ws");
    expect(text).not.toContain("relay.example.net");
  });

  it("explicit edge with no announce at all gets a note, since that cannot be right behind a proxy", () => {
    const { warnings } = relayStartupReport(config({ tlsModeExplicit: true }), peerId, []);
    expect(warnings.join("\n")).toContain("RELAY_ANNOUNCE unset");
  });

  it("a DEFAULTED edge mode is silent -- otherwise every local run cries wolf", () => {
    // A laptop sets neither RELAY_TLS nor RELAY_ANNOUNCE, lands in edge by
    // default, and announces a plain ws address entirely correctly. A warning
    // that fires on every `pnpm start` is one people learn to scroll past,
    // which is precisely what would make the real case above unnoticeable.
    expect(relayStartupReport(config(), peerId, []).warnings).toEqual([]);
    expect(
      relayStartupReport(config({ announce: ["/ip4/192.168.1.5/tcp/9090/ws"] }), peerId, [])
        .warnings,
    ).toEqual([]);
  });

  it("self mode never produces the edge warning, whatever it announces", () => {
    const { warnings } = relayStartupReport(
      config({
        tlsMode: "self",
        tls: { cert: "c", key: "k" },
        tlsModeExplicit: true,
        announce: ["/ip4/203.0.113.9/tcp/9090/ws"],
      }),
      peerId,
      [],
    );
    expect(warnings).toEqual([]);
  });
});

describe("the report states the subnetwork policy", () => {
  it("open says any name is accepted, and that there is still no default", () => {
    const { lines, warnings } = relayStartupReport(config(), peerId, []);
    const text = lines.join("\n");
    expect(text).toContain("mode       open");
    expect(text).toContain("any subnetwork name is accepted");
    // The line an operator needs when a peer of theirs cannot reserve.
    expect(text).toContain("a peer that announces no name is refused");
    expect(warnings).toEqual([]);
  });

  it("registered lists the names it will accept", () => {
    const { lines } = relayStartupReport(
      config({
        mode: "registered",
        networks: [{ name: "one" }, { name: "two" }],
        networksConfigured: true,
      }),
      peerId,
      [],
    );
    const text = lines.join("\n");
    expect(text).toContain("mode       registered");
    expect(text).toContain("only these 2 subnetwork name(s)");
    expect(text).toContain("one");
    expect(text).toContain("two");
  });

  it("warns when RELAY_NETWORKS is set on an open relay -- the list is doing nothing", () => {
    // This starts cleanly and carries every subnetwork there is, which is a
    // fine thing to do on purpose and a bad thing to do by accident.
    const { warnings } = relayStartupReport(config({ networksConfigured: true }), peerId, []);
    expect(warnings.join("\n")).toContain("RELAY_NETWORKS is set, but RELAY_MODE is open");
  });
});

describe("the report states the limits, which are otherwise invisible", () => {
  it("prints all four, and says when they are the shipped ones", () => {
    // On a relay with a public name these are the only thing between an
    // operator and paying for strangers' bandwidth, and nothing outside the
    // process can see them.
    const { lines } = relayStartupReport(config(), peerId, []);
    const text = lines.join("\n");
    expect(text).toContain(`maxReservations   ${DEFAULT_RELAY_LIMITS.maxReservations}`);
    expect(text).toContain(`reservationTtl    ${DEFAULT_RELAY_LIMITS.reservationTtlMs} ms`);
    expect(text).toContain(`perCircuitData    ${DEFAULT_RELAY_LIMITS.defaultDataLimitBytes} bytes`);
    expect(text).toContain(`perCircuitTime    ${DEFAULT_RELAY_LIMITS.defaultDurationLimitMs} ms`);
    // Defaults are unremarkable and say nothing extra.
    expect(text).not.toContain("differ from circuit-relay-v2");
  });

  it("says so when a limit was changed -- 15 means nothing on its own", () => {
    const { lines } = relayStartupReport(
      config({ limits: { ...DEFAULT_RELAY_LIMITS, maxReservations: 4096 } }),
      peerId,
      [],
    );
    const text = lines.join("\n");
    expect(text).toContain("maxReservations   4096");
    expect(text).toContain("differ from circuit-relay-v2");
  });

  it("names the http port and both paths", () => {
    // An operator who cannot reach /health needs to know which port it is on
    // without reading the source.
    const { lines } = relayStartupReport(config({ httpPort: 9099 }), peerId, []);
    const text = lines.join("\n");
    expect(text).toContain(":9099");
    expect(text).toContain("/health");
    expect(text).toContain("/.well-known/httpeers-relay.json");
  });
});
