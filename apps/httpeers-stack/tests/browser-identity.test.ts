/**
 * `src/browser/identity.ts`'s key handling -- the half of it that is pure
 * codec and needs no IndexedDB.
 *
 * WHAT THIS SUITE EXISTS TO PIN, and it is not a formality. The hub page's
 * peerId IS the mesh (`claims.mesh === claims.iss`), and the hub page
 * derives it from a key round-tripped through IndexedDB in a format chosen
 * to match the one `pnpm bootstrap` writes to `.httpeers/hub.key`
 * (`src/setup/keys.ts`). "Chosen to match" is a claim, and an unverified
 * one would be worth nothing: if the two encodings diverged, a hub page and
 * a Node hub built from the same key bytes would be DIFFERENT meshes, and
 * the only symptom would be tokens that mysteriously fail to verify. These
 * tests compare the two paths directly rather than trusting the comment.
 *
 * `loadOrCreateIdentity` / `clearIdentity` are NOT covered here -- they call
 * `idb-keyval`, which needs a browser. Named in this task's report rather
 * than skipped.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { privateKeyToProtobuf } from "@libp2p/crypto/keys";
import { generateMeshKey } from "@statewalker/httpeers.core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decodeIdentity, encodeIdentity, peerIdOf } from "../src/browser/identity.js";
import { loadOrGenerateKey, peerIdOf as nodePeerIdOf } from "../src/setup/keys.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "httpeers-identity-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("the browser identity codec", () => {
  it("round-trips a key without changing the peerId it derives to", async () => {
    const key = await generateMeshKey();
    const restored = decodeIdentity(encodeIdentity(key));

    expect(peerIdOf(restored)).toBe(peerIdOf(key));
    expect(restored.type).toBe("Ed25519");
  });

  it("produces the same bytes `pnpm bootstrap` writes to a key file", async () => {
    // The Node side, through its own code path: generate + persist.
    const keyPath = join(dir, "hub.key");
    const nodeKey = await loadOrGenerateKey({ keyPath, seed: "task-24-fixture" });
    const onDisk = readFileSync(keyPath);

    // The browser side's encoder, given the very same key.
    expect(Buffer.from(encodeIdentity(nodeKey))).toEqual(onDisk);
  });

  it("derives the same peerId the Node path derives -- so the hub page and the Node hub would be the same mesh", async () => {
    const keyPath = join(dir, "hub.key");
    const nodeKey = await loadOrGenerateKey({ keyPath, seed: "task-24-fixture" });

    // Take the key back out of storage the way the browser would -- from
    // bytes -- and derive its peerId with the browser's own function.
    const fromStorage = decodeIdentity(readFileSync(keyPath));

    expect(peerIdOf(fromStorage)).toBe(nodePeerIdOf(nodeKey));
  });

  it("refuses a key that is not Ed25519, naming the storage key", async () => {
    // An RSA key encoded the same way -- what a stored value from some other
    // application, or a much older one of this, could look like. Only the
    // shape of the failure matters: it must be legible, and it must not be
    // a peerId derived from a key this mesh cannot use.
    const { generateKeyPair } = await import("@libp2p/crypto/keys");
    const rsa = await generateKeyPair("RSA", 512);

    expect(() => decodeIdentity(privateKeyToProtobuf(rsa))).toThrow(/only Ed25519 is supported/);
    expect(() => decodeIdentity(privateKeyToProtobuf(rsa))).toThrow(/httpeers:identity-key/);
  });
});
