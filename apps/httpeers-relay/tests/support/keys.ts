/**
 * One Ed25519 relay identity, generated once per test process.
 *
 * Shared because several suites need a `RELAY_KEY` and none of them care which
 * key it is -- `config.test.ts` generates its own in a `beforeAll` and that is
 * fine there; this exists so a suite that needs a key for a single assertion
 * does not have to grow a fixture block to get one.
 */
import { generateKeyPair, privateKeyToProtobuf } from "@libp2p/crypto/keys";

let cached: string | undefined;

/** Generate the shared key. Call once, from a `beforeAll`. */
export async function loadRelayKeyForTests(): Promise<void> {
  cached ??= Buffer.from(privateKeyToProtobuf(await generateKeyPair("Ed25519"))).toString("base64");
}

/** base64 of the protobuf `RELAY_KEY` carries. Requires `loadRelayKeyForTests()` to have run. */
export function relayKeyForTests(): string {
  if (cached == null) throw new Error("call loadRelayKeyForTests() in a beforeAll first");
  return cached;
}
