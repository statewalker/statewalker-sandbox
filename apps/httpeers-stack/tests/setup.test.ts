/**
 * Task 10, Step 4: `pnpm setup` -- key generation and the invitation
 * payload. Every case here operates against a scratch directory
 * (`mkdtempSync`), never the real `.httpeers/`/`httpeers.json` this repo's
 * own `pnpm setup` would write, so this suite is safe to run alongside a
 * real checked-out deployment.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPair, privateKeyFromProtobuf, privateKeyToProtobuf } from "@libp2p/crypto/keys";
import { peerIdFromPrivateKey } from "@libp2p/peer-id";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startHub } from "../src/hub/main.js";
import { startRelay } from "../src/relay/main.js";
import { loadOrGenerateKey, peerIdOf } from "../src/setup/keys.js";
import { type HttpeersConfig, runSetup, type SetupInit } from "../src/setup/main.js";

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "httpeers-setup-"));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function paths(
  dir: string,
): Required<Pick<SetupInit, "relayKeyPath" | "hubKeyPath" | "configPath">> {
  return {
    relayKeyPath: join(dir, ".httpeers", "relay.key"),
    hubKeyPath: join(dir, ".httpeers", "hub.key"),
    configPath: join(dir, "httpeers.json"),
  };
}

describe("setup: a clean directory", () => {
  it("writes both keys and a config whose hubPeerId matches the hub key", async () => {
    const { relayKeyPath, hubKeyPath, configPath } = paths(workDir);
    const result = await runSetup({ relayKeyPath, hubKeyPath, configPath });

    // Both key files exist and are readable back as Ed25519 keys via the
    // exact function `../src/relay/main.ts`'s own `loadRelayKey` uses --
    // see the "the relay's own loader" describe block below for the
    // stronger version of this assertion (calling `loadRelayKey` itself).
    const relayKey = privateKeyFromProtobuf(readFileSync(relayKeyPath));
    const hubKey = privateKeyFromProtobuf(readFileSync(hubKeyPath));
    expect(relayKey.type).toBe("Ed25519");
    expect(hubKey.type).toBe("Ed25519");

    const config: HttpeersConfig = JSON.parse(readFileSync(configPath, "utf8"));
    expect(config.hubPeerId).toBe(peerIdFromPrivateKey(hubKey).toString());
    expect(config.hubPeerId).toBe(result.hubPeerId);
    expect(config.relayAddrs).toHaveLength(1);
    expect(config.relayAddrs[0]).toContain(peerIdFromPrivateKey(relayKey).toString());
    expect(config.relayAddrs[0]).toMatch(/^\/ip4\/127\.0\.0\.1\/tcp\/9090\/ws\/p2p\//);
  });

  it("derives relayAddrs from RELAY_HOST/RELAY_PORT -- an IPv4 literal host stays /ip4/", async () => {
    const { relayKeyPath, hubKeyPath, configPath } = paths(workDir);
    const result = await runSetup({
      relayKeyPath,
      hubKeyPath,
      configPath,
      relayHost: "203.0.113.9",
      relayPort: 12345,
    });

    expect(result.config.relayAddrs[0]).toMatch(/^\/ip4\/203\.0\.113\.9\/tcp\/12345\/ws\/p2p\//);
  });

  it("TLS env produces a wss relay address", async () => {
    const { relayKeyPath, hubKeyPath, configPath } = paths(workDir);
    const result = await runSetup({ relayKeyPath, hubKeyPath, configPath, relayTls: true });

    expect(result.config.relayAddrs[0]).toMatch(/^\/ip4\/127\.0\.0\.1\/tcp\/9090\/wss\/p2p\//);
  });

  it("a RELAY_HOST hostname produces a /dns4/ relay address, not /ip4/", async () => {
    // `net.isIP("relay.example.com")` is 0 (not an IP literal), so
    // `relayAddrFamily` must fall through to `dns4` -- the branch this
    // test pins directly, independent of TLS.
    const { relayKeyPath, hubKeyPath, configPath } = paths(workDir);
    const result = await runSetup({
      relayKeyPath,
      hubKeyPath,
      configPath,
      relayHost: "relay.example.com",
    });

    expect(result.config.relayAddrs[0]).toMatch(
      /^\/dns4\/relay\.example\.com\/tcp\/9090\/ws\/p2p\//,
    );
  });

  it("a hostname RELAY_HOST combined with TLS produces /dns4/.../wss -- the shape a server deployment actually needs", async () => {
    // This is the deployment-relevant combination: a browser cannot dial a
    // bare IP literal over TLS (the certificate would not match it), so a
    // server run's relay address must be BOTH /dns4/ (not /ip4/) AND /wss/
    // (not /ws/) for the "set TLS_CERT/TLS_KEY, no other change" acceptance
    // criterion to actually hold. Matches the design record's own
    // `/dns4/host/tcp/443/wss` example.
    const { relayKeyPath, hubKeyPath, configPath } = paths(workDir);
    const result = await runSetup({
      relayKeyPath,
      hubKeyPath,
      configPath,
      relayHost: "relay.example.com",
      relayPort: 443,
      relayTls: true,
    });

    expect(result.config.relayAddrs[0]).toMatch(
      /^\/dns4\/relay\.example\.com\/tcp\/443\/wss\/p2p\//,
    );
  });

  it("an IPv6 literal RELAY_HOST produces /ip6/ -- falls out of net.isIP for free, not a general address layer", async () => {
    const { relayKeyPath, hubKeyPath, configPath } = paths(workDir);
    const result = await runSetup({
      relayKeyPath,
      hubKeyPath,
      configPath,
      relayHost: "::1",
    });

    expect(result.config.relayAddrs[0]).toMatch(/^\/ip6\/::1\/tcp\/9090\/ws\/p2p\//);
  });
});

describe("setup: idempotence -- running it twice", () => {
  it("does not change either key or the config -- compares actual file bytes, not just 'no error'", async () => {
    const { relayKeyPath, hubKeyPath, configPath } = paths(workDir);

    await runSetup({ relayKeyPath, hubKeyPath, configPath });
    const relayBytesBefore = readFileSync(relayKeyPath);
    const hubBytesBefore = readFileSync(hubKeyPath);
    const configBytesBefore = readFileSync(configPath);

    await runSetup({ relayKeyPath, hubKeyPath, configPath });
    const relayBytesAfter = readFileSync(relayKeyPath);
    const hubBytesAfter = readFileSync(hubKeyPath);
    const configBytesAfter = readFileSync(configPath);

    expect(relayBytesAfter.equals(relayBytesBefore)).toBe(true);
    expect(hubBytesAfter.equals(hubBytesBefore)).toBe(true);
    expect(configBytesAfter.equals(configBytesBefore)).toBe(true);
  });

  it("a third run, with different relayHost/relayPort, still reuses the same keys -- only the addresses change", async () => {
    const { relayKeyPath, hubKeyPath, configPath } = paths(workDir);

    const first = await runSetup({ relayKeyPath, hubKeyPath, configPath });
    const second = await runSetup({
      relayKeyPath,
      hubKeyPath,
      configPath,
      relayHost: "198.51.100.4",
      relayPort: 9999,
    });

    // The mesh identity itself never moves...
    expect(second.hubPeerId).toBe(first.hubPeerId);
    expect(second.relayPeerId).toBe(first.relayPeerId);
    // ...only the address this run's config points at does.
    expect(second.config.relayAddrs[0]).toContain("198.51.100.4");
    expect(second.config.relayAddrs[0]).toContain(first.relayPeerId);
  });
});

describe("setup: RELAY_SEED / HUB_SEED", () => {
  it("HUB_SEED produces a deterministic, documented peerId", async () => {
    const { relayKeyPath, hubKeyPath, configPath } = paths(workDir);
    const result = await runSetup({
      relayKeyPath,
      hubKeyPath,
      configPath,
      hubSeed: "httpeers-test-hub-seed",
    });

    // Documented fixture: "httpeers-test-hub-seed" (SHA-256-expanded to the
    // 32-byte Ed25519 seed `generateKeyPairFromSeed` requires) always
    // derives this exact peerId. If this assertion ever needs to change,
    // the derivation itself changed -- that is the whole point of pinning
    // it here as a constant.
    expect(result.hubPeerId).toBe("12D3KooWRkdxQyt33uJAw6KNQYcVWh7HdH116eCvdZYcMBSUKrsM");
  });

  it("RELAY_SEED produces a deterministic, documented peerId, independent of HUB_SEED", async () => {
    const { relayKeyPath, hubKeyPath, configPath } = paths(workDir);
    const result = await runSetup({
      relayKeyPath,
      hubKeyPath,
      configPath,
      relaySeed: "httpeers-test-relay-seed",
    });

    expect(result.relayPeerId).toBe("12D3KooWAAaLaGEV867vPJ1WGQB9RmFCKcK2abFyMsFkR9uwEXAU");
  });

  it("the same seed always derives the same key, across separate directories", async () => {
    const dirA = mkdtempSync(join(tmpdir(), "httpeers-setup-a-"));
    const dirB = mkdtempSync(join(tmpdir(), "httpeers-setup-b-"));
    try {
      const a = await runSetup({ ...paths(dirA), hubSeed: "same-seed" });
      const b = await runSetup({ ...paths(dirB), hubSeed: "same-seed" });
      expect(a.hubPeerId).toBe(b.hubPeerId);
    } finally {
      rmSync(dirA, { recursive: true, force: true });
      rmSync(dirB, { recursive: true, force: true });
    }
  });

  it("a seed is only consulted the first time a key is written -- an existing key file wins on a later run", async () => {
    const { relayKeyPath, hubKeyPath, configPath } = paths(workDir);
    const first = await runSetup({ relayKeyPath, hubKeyPath, configPath, hubSeed: "seed-one" });

    // A later run passes a DIFFERENT seed; since hub.key already exists,
    // it must be ignored -- the file on disk is the source of truth (see
    // keys.ts's module comment).
    const second = await runSetup({ relayKeyPath, hubKeyPath, configPath, hubSeed: "seed-two" });
    expect(second.hubPeerId).toBe(first.hubPeerId);
  });
});

describe("setup: the generated relay key is readable by the relay's own loader", () => {
  it("startRelay -- the relay's real boot path, which internally calls loadRelayKey -- boots with exactly the peerId setup wrote into httpeers.json", async () => {
    // `loadRelayKey` itself is private to `relay/main.ts` (not exported --
    // its module comment explains why identity generation is deliberately
    // not a public surface), so this calls the one exported entry point
    // that runs it: `startRelay`. If the key file `setup` wrote were not
    // exactly what `privateKeyFromProtobuf` expects, or were not
    // Ed25519, this would throw/exit exactly as `loadRelayKey` documents
    // -- a test that only checked the file existed would not catch that.
    const { relayKeyPath, hubKeyPath, configPath } = paths(workDir);
    const result = await runSetup({ relayKeyPath, hubKeyPath, configPath });

    const relay = await startRelay({ port: 0, keyPath: relayKeyPath });
    try {
      expect(relay.node.peerId.toString()).toBe(result.relayPeerId);
      expect(relay.node.peerId.toString()).toBe(
        JSON.parse(readFileSync(configPath, "utf8")).relayAddrs[0].split("/p2p/")[1],
      );
    } finally {
      await relay.stop();
    }
  });

  it("also round-trips directly through privateKeyFromProtobuf, matching the exact decode loadRelayKey performs", async () => {
    const { relayKeyPath, hubKeyPath, configPath } = paths(workDir);
    await runSetup({ relayKeyPath, hubKeyPath, configPath });

    const bytes = readFileSync(relayKeyPath);
    const key = privateKeyFromProtobuf(bytes);
    expect(key.type).toBe("Ed25519");
  });
});

describe("setup: the hub main.ts actually boots reads back -- closes the loop end to end", () => {
  it("the peerId startHub boots with equals httpeers.json's hubPeerId -- this is the exact gap a stale ephemeral hub key would reopen", async () => {
    // This is the regression case: before hub/main.ts was wired to load
    // `.httpeers/hub.key`, `startHub` minted a fresh key every call, so the
    // peerId it booted with never matched what `setup` had written into
    // httpeers.json a moment earlier -- confirmed by hand (two different
    // peerIds, every run) before this fix landed. Asserting the file
    // exists, or that `runSetup`'s own return value is self-consistent,
    // would not catch that: the bug was entirely in whether the *running
    // hub process* read the file `setup` wrote, not in `setup` itself.
    const { relayKeyPath, hubKeyPath, configPath } = paths(workDir);
    const result = await runSetup({ relayKeyPath, hubKeyPath, configPath });
    const config: HttpeersConfig = JSON.parse(readFileSync(configPath, "utf8"));

    const hub = await startHub({ keyPath: hubKeyPath, listen: ["/ip4/127.0.0.1/tcp/0"] });
    try {
      expect(hub.peer.peerId).toBe(result.hubPeerId);
      expect(hub.peer.peerId).toBe(config.hubPeerId);
    } finally {
      await hub.stop();
    }
  });

  // NOT exercised in-process: `startHub`'s missing-key path calls
  // `process.exit(1)` (mirroring `loadRelayKey`'s own contract exactly --
  // see hub/main.ts's module comment), which would kill this vitest worker
  // rather than let a test observe it. `../relay/main.ts`'s identical
  // ENOENT path is, for the same reason, verified manually rather than by
  // an automated in-process test (see PROVENANCE.md's Task 9 section,
  // "Manual verification"); the hub's was verified the same way -- see
  // this task's own PROVENANCE.md/report entry.
});

describe("keys.ts: loadOrGenerateKey directly", () => {
  it("generates a key on first call and reuses the exact same key on a second call", async () => {
    const keyPath = join(workDir, "role.key");
    const first = await loadOrGenerateKey({ keyPath });
    const firstBytes = readFileSync(keyPath);

    const second = await loadOrGenerateKey({ keyPath });
    const secondBytes = readFileSync(keyPath);

    expect(secondBytes.equals(firstBytes)).toBe(true);
    expect(peerIdOf(second)).toBe(peerIdOf(first));
  });

  it("rejects a non-Ed25519 key file with the same guard the relay's loader uses", async () => {
    const keyPath = join(workDir, "wrong-type.key");
    const secp256k1Key = await generateKeyPair("secp256k1");
    writeFileSync(keyPath, privateKeyToProtobuf(secp256k1Key));

    await expect(loadOrGenerateKey({ keyPath })).rejects.toThrow(/secp256k1.*Ed25519|Ed25519/);
  });
});
