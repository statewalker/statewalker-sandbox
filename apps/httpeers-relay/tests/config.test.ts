/**
 * T1/T2/T3: everything the relay reads from the environment, and every way it
 * can be told something it cannot act on.
 *
 * These cases exist because `resolveRelayConfig` throws rather than calling
 * `process.exit`. The version of this loader that lived in
 * `apps/httpeers-stack/src/relay/main.ts` exited from library code, so its
 * missing-key and bad-key paths could not be asserted at all -- the stack's
 * own suite says so in a comment, and verified them by hand instead. Those
 * are the paths an operator meets on a bad day; they are asserted here.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPair, privateKeyToProtobuf } from "@libp2p/crypto/keys";
import { peerIdFromPrivateKey } from "@libp2p/peer-id";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_RELAY_KEY_PATH,
  DEFAULT_RELAY_PORT,
  RelayConfigError,
  type RelayEnv,
  resolveRelayConfig,
} from "../src/config.js";
import { generateRelayIdentity } from "../src/keygen.js";

let workDir: string;
let keyPath: string;
let relayKey: string;
let expectedPeerId: string;

beforeEach(async () => {
  workDir = mkdtempSync(join(tmpdir(), "httpeers-relay-config-"));
  keyPath = join(workDir, "relay.key");
  const key = await generateKeyPair("Ed25519");
  writeFileSync(keyPath, privateKeyToProtobuf(key));
  relayKey = Buffer.from(privateKeyToProtobuf(key)).toString("base64");
  expectedPeerId = peerIdFromPrivateKey(key).toString();
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

/** A configuration error, with its message, or a failure naming what came back instead. */
function expectConfigError(env: RelayEnv): string {
  try {
    resolveRelayConfig(env);
  } catch (err) {
    expect(err).toBeInstanceOf(RelayConfigError);
    return (err as Error).message;
  }
  throw new Error("expected resolveRelayConfig to throw a RelayConfigError, but it returned");
}

describe("T1: the identity comes from a secret, or from a file, or the relay refuses to start", () => {
  it("RELAY_KEY yields the peerId that key derives", () => {
    const config = resolveRelayConfig({ RELAY_KEY: relayKey });
    expect(peerIdFromPrivateKey(config.privateKey).toString()).toBe(expectedPeerId);
    expect(config.keySource).toBe("RELAY_KEY");
  });

  it("the SAME secret yields the SAME peerId every time it is resolved -- this is the whole point", () => {
    // A container host's filesystem does not survive a deploy. Resolving the
    // same secret repeatedly, from scratch, is what a redeploy is: if this
    // ever differed, every published multiaddr would break on every restart
    // and the symptom would be "peers cannot connect", which points nowhere
    // near the relay.
    const peerIds = new Set(
      [0, 1, 2].map(() =>
        peerIdFromPrivateKey(resolveRelayConfig({ RELAY_KEY: relayKey }).privateKey).toString(),
      ),
    );
    expect([...peerIds]).toEqual([expectedPeerId]);
  });

  it("RELAY_KEY and RELAY_KEY_PATH holding DIFFERENT keys: the secret wins", async () => {
    // The precedence is the point of T1. A container image may well ship with
    // a stale key file baked in or mounted; the deployment's secret is the
    // identity, and a relay that preferred the file would come back as a
    // different peer while looking configured.
    const other = await generateKeyPair("Ed25519");
    const otherPath = join(workDir, "other.key");
    writeFileSync(otherPath, privateKeyToProtobuf(other));

    const config = resolveRelayConfig({ RELAY_KEY: relayKey, RELAY_KEY_PATH: otherPath });
    expect(peerIdFromPrivateKey(config.privateKey).toString()).toBe(expectedPeerId);
    expect(peerIdFromPrivateKey(config.privateKey).toString()).not.toBe(
      peerIdFromPrivateKey(other).toString(),
    );
  });

  it("RELAY_KEY_PATH is read when RELAY_KEY is absent, and names itself in keySource", () => {
    const config = resolveRelayConfig({ RELAY_KEY_PATH: keyPath });
    expect(peerIdFromPrivateKey(config.privateKey).toString()).toBe(expectedPeerId);
    expect(config.keySource).toContain(keyPath);
  });

  it("a key file and the base64 of that same file are the same identity", async () => {
    // The two ways in must not be two formats. `RELAY_KEY` is documented as
    // the base64 of exactly the bytes the file holds, and an operator will
    // migrate from one to the other with `base64 -w0` on the key file.
    const fromFile = resolveRelayConfig({ RELAY_KEY_PATH: keyPath });
    const fromSecret = resolveRelayConfig({ RELAY_KEY: relayKey });
    expect(peerIdFromPrivateKey(fromSecret.privateKey).toString()).toBe(
      peerIdFromPrivateKey(fromFile.privateKey).toString(),
    );
  });

  it("neither present: the guidance names BOTH options, not only the reference stack's bootstrap", () => {
    const message = expectConfigError({ RELAY_KEY_PATH: join(workDir, "absent.key") });
    expect(message).toContain("RELAY_KEY");
    expect(message).toContain("RELAY_KEY_PATH");
    expect(message).toContain("pnpm keygen");
    // And it still explains why an ephemeral identity is not an acceptable
    // fallback -- the reason the process exits rather than generating one.
    expect(message).toContain("peerId is embedded in");
  });

  it("neither present, no RELAY_KEY_PATH set either: still names both, and the default path", () => {
    const message = expectConfigError({ RELAY_KEY_PATH: undefined, RELAY_KEY: undefined });
    expect(message).toContain("RELAY_KEY");
    expect(message).toContain(DEFAULT_RELAY_KEY_PATH);
  });

  it("a malformed RELAY_KEY fails with a readable message, not a protobuf stack trace", () => {
    const message = expectConfigError({ RELAY_KEY: "this is definitely not a key" });
    expect(message).toContain("RELAY_KEY is not a libp2p private key");
    expect(message).toContain("privateKeyToProtobuf");
    expect(message).not.toMatch(/at .*\(.*:\d+:\d+\)/);
  });

  it("a TRUNCATED RELAY_KEY -- the realistic paste error -- is caught the same way", () => {
    const message = expectConfigError({ RELAY_KEY: relayKey.slice(0, relayKey.length - 8) });
    expect(message).toContain("RELAY_KEY is not a libp2p private key");
    expect(message).toContain("truncated");
  });

  it("an empty RELAY_KEY is a distinct, named failure rather than a decode error", () => {
    // `Buffer.from("", "base64")` yields zero bytes without complaint, so
    // without this case an unset-but-exported secret would die inside
    // protobuf parsing talking about wire types.
    const message = expectConfigError({ RELAY_KEY: "   " });
    expect(message).toContain("decodes to nothing");
  });

  it("a non-Ed25519 key is refused, from the secret and from the file alike -- as it is today", async () => {
    const other = await generateKeyPair("secp256k1");
    const otherPath = join(workDir, "secp256k1.key");
    writeFileSync(otherPath, privateKeyToProtobuf(other));

    expect(expectConfigError({ RELAY_KEY_PATH: otherPath })).toContain("only Ed25519 is supported");
    expect(
      expectConfigError({ RELAY_KEY: Buffer.from(privateKeyToProtobuf(other)).toString("base64") }),
    ).toContain("only Ed25519 is supported");
  });

  it("a key file that is not a protobuf at all names the file, not the encoding library", () => {
    const junkPath = join(workDir, "junk.key");
    writeFileSync(junkPath, "-----BEGIN OPENSSH PRIVATE KEY-----\n");
    const message = expectConfigError({ RELAY_KEY_PATH: junkPath });
    expect(message).toContain(junkPath);
    expect(message).toContain("privateKeyToProtobuf");
  });

  it("pnpm keygen's output is exactly what RELAY_KEY accepts, and reports the matching peerId", async () => {
    // The guidance above tells an operator to run `pnpm keygen`. If its output
    // were not directly usable, that advice would be a dead end -- which is
    // the failure mode the guidance exists to avoid.
    const identity = await generateRelayIdentity();
    const config = resolveRelayConfig({ RELAY_KEY: identity.relayKey });
    expect(peerIdFromPrivateKey(config.privateKey).toString()).toBe(identity.peerId);
  });
});

describe("T2: announce is independent of listen", () => {
  it("by default announce is empty, so the relay announces what it listens on -- today's behaviour", () => {
    const config = resolveRelayConfig({ RELAY_KEY: relayKey });
    expect(config.announce).toEqual([]);
    expect(config.listen).toEqual([`/ip4/0.0.0.0/tcp/${DEFAULT_RELAY_PORT}/ws`]);
  });

  it("RELAY_ANNOUNCE is a comma-separated list, trimmed, and does not touch listen", () => {
    const config = resolveRelayConfig({
      RELAY_KEY: relayKey,
      RELAY_PORT: "9099",
      RELAY_ANNOUNCE: "/dns4/relay.example.net/tcp/443/wss , /ip4/203.0.113.9/tcp/443/wss",
    });
    expect(config.announce).toEqual([
      "/dns4/relay.example.net/tcp/443/wss",
      "/ip4/203.0.113.9/tcp/443/wss",
    ]);
    expect(config.listen).toEqual(["/ip4/0.0.0.0/tcp/9099/ws"]);
  });

  it("an unparseable announce address refuses the start, naming the entry at fault", () => {
    // A relay announcing garbage is unreachable in a way nothing else will
    // diagnose: it starts, listens and holds reservations, and the only
    // symptom is transport errors in other people's processes.
    const message = expectConfigError({
      RELAY_KEY: relayKey,
      RELAY_ANNOUNCE: "/dns4/relay.example.net/tcp/443/wss,relay.example.net:443",
    });
    expect(message).toContain("relay.example.net:443");
    expect(message).toContain("is not a multiaddr");
  });

  it("a well-formed multiaddr with a nonsense component is refused too", () => {
    expect(
      expectConfigError({ RELAY_KEY: relayKey, RELAY_ANNOUNCE: "/dns4/x/tcp/not-a-port/wss" }),
    ).toContain("is not a multiaddr");
  });

  it("RELAY_ANNOUNCE set to nothing at all is refused rather than silently meaning 'default'", () => {
    expect(expectConfigError({ RELAY_KEY: relayKey, RELAY_ANNOUNCE: " , " })).toContain(
      "contains no addresses",
    );
  });
});

describe("T3: the TLS mode is chosen, and a choice that cannot work is refused", () => {
  it("unset, with no certificate, means edge -- and edge listens plain ws", () => {
    const config = resolveRelayConfig({ RELAY_KEY: relayKey });
    expect(config.tlsMode).toBe("edge");
    expect(config.tlsModeExplicit).toBe(false);
    expect(config.listen[0]).toMatch(/\/ws$/);
    expect(config.tls).toBeUndefined();
  });

  it("unset, with TLS_CERT and TLS_KEY present, means self -- exactly the old behaviour", () => {
    const { certPath, keyFilePath } = writePem(workDir);
    const config = resolveRelayConfig({
      RELAY_KEY: relayKey,
      TLS_CERT: certPath,
      TLS_KEY: keyFilePath,
    });
    expect(config.tlsMode).toBe("self");
    expect(config.tlsModeExplicit).toBe(false);
    expect(config.listen[0]).toMatch(/\/wss$/);
    expect(config.tls).toEqual({ cert: "CERT-PEM\n", key: "KEY-PEM\n" });
  });

  it("RELAY_TLS=edge listens plain ws even when a certificate happens to be around", () => {
    const { certPath, keyFilePath } = writePem(workDir);
    const config = resolveRelayConfig({
      RELAY_KEY: relayKey,
      RELAY_TLS: "edge",
      TLS_CERT: certPath,
      TLS_KEY: keyFilePath,
    });
    expect(config.tlsMode).toBe("edge");
    expect(config.tlsModeExplicit).toBe(true);
    expect(config.listen[0]).toMatch(/\/ws$/);
    expect(config.tls).toBeUndefined();
  });

  it("RELAY_TLS=self with no certificate is refused, not quietly downgraded to plain ws", () => {
    // Listening plain when the operator asked to terminate TLS is the one
    // outcome that looks exactly like success and is not.
    const message = expectConfigError({ RELAY_KEY: relayKey, RELAY_TLS: "self" });
    expect(message).toContain("TLS_CERT and TLS_KEY are not both set");
    expect(message).toContain("RELAY_TLS=edge");
  });

  it("RELAY_TLS=self with a TLS_CERT that does not exist says so, and says it wants a file", () => {
    const message = expectConfigError({
      RELAY_KEY: relayKey,
      RELAY_TLS: "self",
      TLS_CERT: join(workDir, "absent.pem"),
      TLS_KEY: join(workDir, "absent.pem"),
    });
    expect(message).toContain("names a PEM FILE, not the PEM itself");
  });

  it("an unknown RELAY_TLS value is refused and both modes are listed", () => {
    const message = expectConfigError({ RELAY_KEY: relayKey, RELAY_TLS: "true" });
    expect(message).toContain("is not a mode");
    expect(message).toContain("self");
    expect(message).toContain("edge");
  });
});

describe("RELAY_PORT", () => {
  it("defaults to 9090", () => {
    expect(resolveRelayConfig({ RELAY_KEY: relayKey }).listen[0]).toContain(
      `/tcp/${DEFAULT_RELAY_PORT}/`,
    );
  });

  it("0 is allowed -- an arbitrary free port, which is what a test wants", () => {
    expect(resolveRelayConfig({ RELAY_KEY: relayKey, RELAY_PORT: "0" }).listen[0]).toContain(
      "/tcp/0/",
    );
  });

  it("a non-numeric port is refused rather than becoming NaN in a multiaddr", () => {
    expect(expectConfigError({ RELAY_KEY: relayKey, RELAY_PORT: "eighty" })).toContain(
      "is not a port number",
    );
  });
});

describe("RELAY_MODE and RELAY_NETWORKS", () => {
  it("defaults to open, with no registered list", () => {
    const config = resolveRelayConfig({ RELAY_KEY: relayKey });
    expect(config.mode).toBe("open");
    expect(config.networks).toEqual([]);
    expect(config.networksConfigured).toBe(false);
  });

  it("registered parses its list into descriptors, not bare strings", () => {
    // The shape is what lets an `issuerPublicKey` variant arrive later
    // without a config migration -- see `RelayNetworkDescriptor`.
    const config = resolveRelayConfig({
      RELAY_KEY: relayKey,
      RELAY_MODE: "registered",
      RELAY_NETWORKS: "one, two ,three",
    });
    expect(config.mode).toBe("registered");
    expect(config.networks).toEqual([{ name: "one" }, { name: "two" }, { name: "three" }]);
  });

  it("a repeated name is one subnetwork, not two", () => {
    expect(
      resolveRelayConfig({
        RELAY_KEY: relayKey,
        RELAY_MODE: "registered",
        RELAY_NETWORKS: "one,one",
      }).networks,
    ).toEqual([{ name: "one" }]);
  });

  it("open keeps the list out of the policy but records that it was set", () => {
    // So the startup report can say the list is being ignored rather than
    // leaving an operator to believe it is in force.
    const config = resolveRelayConfig({ RELAY_KEY: relayKey, RELAY_NETWORKS: "one" });
    expect(config.mode).toBe("open");
    expect(config.networks).toEqual([]);
    expect(config.networksConfigured).toBe(true);
  });

  it("registered with an empty list is refused -- it would accept nobody at all", () => {
    const message = expectConfigError({ RELAY_KEY: relayKey, RELAY_MODE: "registered" });
    expect(message).toContain("RELAY_NETWORKS names no subnetworks");
    expect(message).toContain("indistinguishable");
  });

  it("an unusable subnetwork name is refused at startup, naming the entry", () => {
    const message = expectConfigError({
      RELAY_KEY: relayKey,
      RELAY_MODE: "registered",
      RELAY_NETWORKS: "fine,not a name",
    });
    expect(message).toContain('"not a name"');
  });

  it("an unknown RELAY_MODE is refused and both modes are listed", () => {
    const message = expectConfigError({ RELAY_KEY: relayKey, RELAY_MODE: "closed" });
    expect(message).toContain("is not a mode");
    expect(message).toContain("open");
    expect(message).toContain("registered");
    // And the one thing neither mode does.
    expect(message).toContain("Neither mode has a default subnetwork");
  });
});

function writePem(dir: string): { certPath: string; keyFilePath: string } {
  const certPath = join(dir, "cert.pem");
  const keyFilePath = join(dir, "key.pem");
  writeFileSync(certPath, "CERT-PEM\n");
  writeFileSync(keyFilePath, "KEY-PEM\n");
  return { certPath, keyFilePath };
}
