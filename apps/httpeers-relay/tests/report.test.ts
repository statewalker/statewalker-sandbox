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
import type { ResolvedRelayConfig } from "../src/config.js";
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
    const text = relayStartupReport(config({ tlsModeExplicit: false }), peerId, []).lines.join("\n");
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
