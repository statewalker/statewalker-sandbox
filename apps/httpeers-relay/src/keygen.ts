/**
 * Prints a fresh relay identity: the base64 `RELAY_KEY` wants, and the peerId
 * it yields.
 *
 * WHY THIS EXISTS. `RELAY_KEY` is documented as "base64 of an Ed25519 private
 * key in libp2p's protobuf encoding", which is precise and useless to someone
 * who has not read `@libp2p/crypto`. Guidance an operator cannot act on is not
 * guidance, and the alternative -- telling them to clone the reference stack
 * and run its bootstrap to get a key for a relay that is deliberately no
 * longer part of that stack -- is exactly the "deliberately painful self-host
 * path" the project's own position rules out.
 *
 * IT PRINTS, IT DOES NOT WRITE. Nothing here touches `.httpeers/`, so this
 * command cannot overwrite an existing identity by being run twice. The
 * peerId is printed alongside because it is the value the operator must
 * record and later confirm did not change: identity loss is silent, and the
 * only defence is having written the expected peerId down somewhere.
 */

import { generateKeyPair, privateKeyToProtobuf } from "@libp2p/crypto/keys";
import { peerIdFromPrivateKey } from "@libp2p/peer-id";
import { isProcessEntry } from "./entry.js";

export async function generateRelayIdentity(): Promise<{ peerId: string; relayKey: string }> {
  const key = await generateKeyPair("Ed25519");
  return {
    peerId: peerIdFromPrivateKey(key).toString(),
    relayKey: Buffer.from(privateKeyToProtobuf(key)).toString("base64"),
  };
}

if (isProcessEntry(import.meta.url)) {
  const { peerId, relayKey } = await generateRelayIdentity();
  console.log("# A new relay identity. Keep RELAY_KEY secret and back it up OFFLINE:");
  console.log("# losing it loses this relay's peerId, and with it every address ever");
  console.log("# published for it -- every httpeers.json, every invitation, every QR.");
  console.log(`# peerId: ${peerId}`);
  console.log(`RELAY_KEY=${relayKey}`);
}
