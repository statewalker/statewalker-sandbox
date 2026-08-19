/**
 * Key management for `pnpm setup`: one Ed25519 signing key per component
 * role (relay, hub), persisted at `.httpeers/<role>.key` and reused
 * thereafter -- design note 05 §2's reason for Ed25519-only (the peerId
 * inlines the public key, so verification never needs a fetch) is also why
 * this file never branches on key type: everything it touches only ever
 * produces or reads an `Ed25519PrivateKey`.
 *
 * IDEMPOTENCE IS THE WHOLE POINT. `loadOrGenerateKey` is written so that a
 * key file, once it exists, is *read*, never regenerated or overwritten --
 * there is no code path in this file that writes to `keyPath` when
 * `existsSync(keyPath)` is true. This matters most for the hub: its peerId
 * IS the mesh identity (every token's `mesh` claim restates it, which is
 * what lets a provider verify a token offline with no key fetch). A
 * `loadOrGenerateKey` that quietly re-derived a key on a second call would
 * mean every previously issued token silently stops verifying, every
 * `.access` policy naming the issuer goes stale, and `pnpm setup` run a
 * second time (e.g. after a crash, or by a second operator on the same
 * checkout) would have invisibly re-founded the mesh.
 *
 * KEY FILE FORMAT: the protobuf encoding `@libp2p/crypto/keys`'s own
 * `privateKeyToProtobuf`/`privateKeyFromProtobuf` round-trip through -- the
 * exact format `../relay/main.ts`'s `loadRelayKey` reads back
 * (`privateKeyFromProtobuf(readFileSync(keyPath))`), and the same package
 * `httpeers.core`'s `tokens.ts` already depends on for `generateMeshKey`.
 * Not a choice made independently here; see that file's module comment for
 * the contract this format exists to satisfy.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  generateKeyPair,
  generateKeyPairFromSeed,
  privateKeyFromProtobuf,
  privateKeyToProtobuf,
} from "@libp2p/crypto/keys";
import type { Ed25519PrivateKey } from "@libp2p/interface";
import { peerIdFromPrivateKey } from "@libp2p/peer-id";

/** `generateKeyPairFromSeed("Ed25519", seed)` requires exactly a 32-byte seed. */
const SEED_BYTES = 32;

export interface LoadOrGenerateKeyInit {
  /** Where to read the key from, or write a freshly generated one to. */
  keyPath: string;
  /**
   * When set AND no key yet exists at `keyPath`, the fresh key is derived
   * deterministically from this string (via SHA-256, to expand an
   * arbitrary-length env var into `@libp2p/crypto`'s required 32-byte
   * seed) instead of drawn from the system CSPRNG -- so tests and CI can
   * name a peerId as a constant. Ignored once a key file already exists:
   * the file on disk, not the seed, is the source of truth from then on
   * (see the module comment's idempotence note).
   */
  seed?: string;
}

/**
 * Reads the Ed25519 key at `init.keyPath`, generating and persisting one
 * first if the file does not exist yet. Safe to call any number of times
 * against the same path -- see the module comment.
 */
export async function loadOrGenerateKey(init: LoadOrGenerateKeyInit): Promise<Ed25519PrivateKey> {
  const { keyPath, seed } = init;

  if (existsSync(keyPath)) {
    const key = privateKeyFromProtobuf(readFileSync(keyPath));
    if (key.type !== "Ed25519") {
      throw new Error(
        `setup: key at "${keyPath}" is a ${key.type} key -- only Ed25519 is supported (design note 05 §2).`,
      );
    }
    return key;
  }

  const key =
    seed != null
      ? await generateKeyPairFromSeed("Ed25519", deriveSeedBytes(seed))
      : await generateKeyPair("Ed25519");

  mkdirSync(dirname(keyPath), { recursive: true });
  writeFileSync(keyPath, privateKeyToProtobuf(key));
  return key;
}

/**
 * Expands an arbitrary-length seed string (`RELAY_SEED`/`HUB_SEED`) to the
 * fixed 32 bytes `generateKeyPairFromSeed` requires. SHA-256 rather than
 * e.g. truncation/padding: deterministic, fixed-length regardless of input
 * length, and any single-character change in the input produces an
 * unrelated key -- exactly the property a "name a peerId as a constant"
 * test fixture needs.
 */
function deriveSeedBytes(seed: string): Uint8Array {
  const digest = createHash("sha256").update(seed, "utf8").digest();
  if (digest.length !== SEED_BYTES) {
    // Unreachable in practice (SHA-256 always yields 32 bytes) -- guards
    // the contract explicitly rather than trusting it silently, since a
    // wrong-length seed here would fail deep inside `@libp2p/crypto`
    // with a much less legible error.
    throw new Error(`setup: derived seed is ${digest.length} bytes, expected ${SEED_BYTES}.`);
  }
  return digest;
}

/** The peerId a key derives to -- the same computation `httpeers.core`'s `mintToken` uses. */
export function peerIdOf(key: Ed25519PrivateKey): string {
  return peerIdFromPrivateKey(key).toString();
}
