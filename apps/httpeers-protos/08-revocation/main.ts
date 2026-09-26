/**
 * 08 — Revocation as a pulled, cached deny list.
 */
import { heading } from "../lib/nodes.ts";
import { Hub, RevocationCache } from "../lib/revocation.ts";

heading("08 — removing a member stops their live token");

let now = 1_000_000;
const clock = () => now;
const hub = new Hub(clock);
const cache = new RevocationCache();

const HEARTBEAT_MS = 5_000;
const TTL_MS = 30_000;

/** What a provider does on each heartbeat: pull only if the counter moved. */
function heartbeat(): boolean {
  if (hub.policyVersion() === cache.knownVersion()) return false;
  cache.update(hub.changeList());
  return true;
}
heartbeat();

const aliceToken = hub.mint("alice", ["std:reader"], TTL_MS);
console.log(`alice's token: iat=${aliceToken.iat} exp=${aliceToken.exp} (TTL ${TTL_MS / 1000}s)`);
console.log(`before removal          -> ${cache.check(aliceToken) ?? "\x1b[32maccepted\x1b[0m"}`);

// The hub removes her. Her token is still cryptographically valid and unexpired.
now += 1_000;
hub.remove("alice");
console.log(`\nhub.remove("alice") at t+1s — her token is still unexpired and well-formed`);
console.log(
  `provider, before next heartbeat -> ${cache.check(aliceToken) ?? "\x1b[31maccepted (stale cache)\x1b[0m"}`,
);

// The next heartbeat carries a bumped counter, so the provider pulls once.
now += HEARTBEAT_MS;
const pulled = heartbeat();
const refused = cache.check(aliceToken);
console.log(`\nheartbeat at t+6s: counter moved -> pulled change list: ${pulled}`);
console.log(
  `provider, after heartbeat       -> ${refused ? `\x1b[32mrefused: ${refused}\x1b[0m` : "\x1b[31maccepted\x1b[0m"}`,
);
console.log(
  `worst-case exposure             = one heartbeat interval (${HEARTBEAT_MS / 1000}s), not the ${TTL_MS / 1000}s TTL`,
);

// Re-admission is why `iat` exists: a token minted AFTER the change is fine.
now += 1_000;
const readmitted = hub.mint("alice", ["std:reader"], TTL_MS);
const readmitCheck = cache.check(readmitted);
console.log(`\nre-admitted, fresh token minted at t+7s (iat ${readmitted.iat} > changedAt)`);
console.log(`provider                        -> ${readmitCheck ?? "\x1b[32maccepted\x1b[0m"}`);
console.log("  without `iat` this is impossible: revocation would be all-or-nothing per peer");

// A quiet period must not cause needless pulls.
now += HEARTBEAT_MS;
const pulledAgain = heartbeat();
console.log(
  `\nheartbeat with no changes       -> pulled again: ${pulledAgain} ${pulledAgain ? "\x1b[31m✗\x1b[0m" : "\x1b[32m✓ hub stays off the request path\x1b[0m"}`,
);

const ok = refused !== null && readmitCheck === null && !pulledAgain;
console.log(
  ok
    ? "\n\x1b[32m✓ revoked within one heartbeat, re-admission works, no polling when nothing changed\x1b[0m"
    : "\n\x1b[31m✗ revocation behaved incorrectly\x1b[0m",
);
process.exit(ok ? 0 : 1);
