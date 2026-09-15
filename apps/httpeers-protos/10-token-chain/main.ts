/**
 * Prototype 10 — mint -> attenuate -> verify, against real Ed25519 keys.
 *
 * Proves the token half of block A, which every prior prototype stubbed: protos 03,
 * 07 and 09 were handed `{mesh, roles}` directly or read a local map keyed by peer id.
 * No transport is involved, which is itself criterion A-19 and is checked below.
 *
 * Each scenario PRINTS its finding rather than only asserting it.
 */
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  LIMITS,
  attenuate,
  delegateTo,
  forgeDelegation,
  mintAuthority,
  newKeyPair,
  verify,
  type VerifyContext,
} from "./tokens.js";

const HUB = newKeyPair();
const ALICE = newKeyPair();          // Alice's device signing key (for delegation)
const MESH = "mesh:H";
const ALICE_KEY = "peerkey:alice-laptop";
const ALICE_PHONE = "peerkey:alice-phone";
const PROXY_KEY = "peerkey:reverse-proxy";
const THIEF_KEY = "peerkey:thief";
const SERVER = "peerkey:notes-server";
const OTHER = "peerkey:other-server";

const NOW = new Date("2026-08-21T12:00:00Z");
const SOON = new Date("2026-08-21T13:00:00Z");
const PAST = new Date("2026-08-21T11:00:00Z");

/** The node's own rule set: the vocabulary as rules (ADR-0016 amendment). */
const RULES = [
  'capability("app:notes.read")  <- role("app:reader");',
  'capability("app:notes.write") <- role("app:editor");',
  'role("app:reader")            <- role("app:editor");',   // implication, transitive for free
];
const POLICIES = [
  'allow if resource($r), $r.starts_with("/notes"), operation("GET"),  capability("app:notes.read");',
  'allow if resource($r), $r.starts_with("/notes"), operation("PUT"),  capability("app:notes.write");',
];

const base = (over: Partial<VerifyContext> = {}): VerifyContext => ({
  root: HUB.getPublicKey(),
  connectionPeer: ALICE_KEY,
  selfPeer: SERVER,
  now: NOW,
  operation: "GET",
  resource: "/notes/2026-08-21",
  rules: RULES,
  policies: POLICIES,
  ...over,
});

let pass = 0;
let fail = 0;

function scenario(id: string, what: string, expected: "allow" | "deny", run: () => ReturnType<typeof verify>): void {
  const r = run();
  const got = r.allowed ? "allow" : "deny";
  const ok = got === expected;
  ok ? pass++ : fail++;
  console.log(`\n${ok ? "PASS" : "FAIL"}  ${id}  ${what}`);
  console.log(`      expected ${expected}, got ${got}`);
  if (r.allowed) console.log(`      matched allow policy #${r.policy}`);
  if (r.signatureError) console.log(`      signature: ${r.signatureError}`);
  if (r.budgetExceeded) console.log(`      evaluation budget exhausted (P9)`);
  for (const f of r.failed ?? []) console.log(`      failed -> ${f}`);
}

console.log("=".repeat(78));
console.log("prototype 10 — mint -> attenuate -> verify");
console.log("=".repeat(78));
console.log(`hub key   ${HUB.getPublicKey().toString().slice(0, 24)}...`);
console.log(`alice key ${ALICE.getPublicKey().toString().slice(0, 24)}...`);

// ---------------------------------------------------------------- mint + verify
const aliceToken = mintAuthority(
  { mesh: MESH, subject: "user:alice", bound: ALICE_KEY, roles: ["app:editor"], expiresAt: SOON },
  HUB.getPrivateKey(),
);
console.log(`\nminted authority token, ${aliceToken.length} chars base64`);

scenario("T10-01", "a bound token, presented over its own connection", "allow", () =>
  verify(aliceToken, base()));

scenario("T10-02", "role implication derives the read capability transitively", "allow", () =>
  verify(aliceToken, base({ operation: "GET" })));

scenario("T10-03", "editor may PUT", "allow", () =>
  verify(aliceToken, base({ operation: "PUT" })));

scenario("T10-04", "nothing grants DELETE, so nothing permits it (deny by default)", "deny", () =>
  verify(aliceToken, base({ operation: "DELETE" })));

// ------------------------------------------------------------------- A-11 binding
scenario("T10-05", "A-11 same token presented over a DIFFERENT proven key", "deny", () =>
  verify(aliceToken, base({ connectionPeer: THIEF_KEY })));

// ------------------------------------------------------- A-12 forwarding a token
scenario("T10-06", "A-12 the server replays Alice's token to another peer", "deny", () =>
  verify(aliceToken, base({ connectionPeer: SERVER, selfPeer: OTHER })));

// ---------------------------------------------------- A-13 delegation by default
const forged = forgeDelegation(aliceToken, HUB.getPublicKey(), THIEF_KEY);
scenario("T10-07", "A-13 no delegation permission: an appended delegate block", "deny", () =>
  verify(forged, base({ connectionPeer: THIEF_KEY })));

// -------------------------------------------- delegation, pre-authorized (0010)
const delegable = mintAuthority(
  {
    mesh: MESH, subject: "user:alice", bound: ALICE_KEY, roles: ["app:editor"],
    expiresAt: SOON, delegationKey: ALICE.getPublicKey(),
  },
  HUB.getPrivateKey(),
);

const stolen = forgeDelegation(delegable, HUB.getPublicKey(), THIEF_KEY);
scenario("T10-08", "a thief appends a PLAIN delegate block naming itself", "deny", () =>
  verify(stolen, base({ connectionPeer: THIEF_KEY })));

const delegated = delegateTo(delegable, HUB.getPublicKey(), ALICE, {
  to: PROXY_KEY,
  restrict: ['check if operation("GET");'],
});
scenario("T10-09", "Alice signs a third-party block naming the proxy", "allow", () =>
  verify(delegated, base({ connectionPeer: PROXY_KEY })));

scenario("T10-10", "the delegation NARROWS: the proxy may not PUT", "deny", () =>
  verify(delegated, base({ connectionPeer: PROXY_KEY, operation: "PUT" })));

scenario("T10-11", "Alice may still PUT with her own token", "allow", () =>
  verify(delegable, base({ operation: "PUT" })));

// ------------------------------------------------------- A-23 widening is impossible
const widened = attenuate(aliceToken, HUB.getPublicKey(), []);
const widenedPlus = forgeDelegation(widened, HUB.getPublicKey(), ALICE_KEY);
scenario("T10-12", "A-23 an appended block asserting a role it was not granted", "deny", () =>
  verify(widenedPlus, base({
    policies: ['allow if role("std:admin");'],
  })));

// Control for T10-12. Without this, T10-12 proves nothing: NoMatchingPolicy is also
// what a policy that can NEVER match looks like. Same policy, same authorizer — the
// only difference is WHICH BLOCK carries role("std:admin").
const genuineAdmin = mintAuthority(
  { mesh: MESH, subject: "user:root", bound: ALICE_KEY, roles: ["std:admin"], expiresAt: SOON },
  HUB.getPrivateKey(),
);
scenario("T10-12b", "control: the same policy DOES match when the hub granted the role", "allow", () =>
  verify(genuineAdmin, base({ policies: ['allow if role("std:admin");'] })));

// ------------------------------------------------------------------- A-24 audience
const scoped = mintAuthority(
  { mesh: MESH, subject: "user:alice", bound: ALICE_KEY, roles: ["app:editor"], expiresAt: SOON, audience: [SERVER] },
  HUB.getPrivateKey(),
);
scenario("T10-13", "A-24 audience-scoped token at its intended destination", "allow", () =>
  verify(scoped, base()));

scenario("T10-14", "A-24 the SAME token at a different destination, which refuses", "deny", () =>
  verify(scoped, base({ selfPeer: OTHER })));

// -------------------------------------------------------------------- A-14 expiry
const expired = mintAuthority(
  { mesh: MESH, subject: "user:alice", bound: ALICE_KEY, roles: ["app:editor"], expiresAt: PAST },
  HUB.getPrivateKey(),
);
scenario("T10-15", "A-14 an expired token, against the injected clock", "deny", () =>
  verify(expired, base()));

// ------------------------------------------------------------- A-15 wrong mesh key
const OTHER_HUB = newKeyPair();
scenario("T10-16", "A-15 a token verified against a different mesh key", "deny", () =>
  verify(aliceToken, base({ root: OTHER_HUB.getPublicKey() })));

// ------------------------------------------------- A-20 unknown constraint fails closed
const futureToken = mintAuthority(
  {
    mesh: MESH, subject: "user:alice", bound: ALICE_KEY, roles: ["app:editor"], expiresAt: SOON,
    extraChecks: ["check if quantum_safe(true);"],   // no verifier today supplies this
  },
  HUB.getPrivateKey(),
);
scenario("T10-17", "A-20 a constraint this verifier has never heard of", "deny", () =>
  verify(futureToken, base()));

scenario("T10-18", "A-20 the same token once the verifier supplies the predicate", "allow", () =>
  verify(futureToken, base({ extraFacts: ["quantum_safe(true);"] })));

// -------------------------------------------------------------- A-21 revocation
const phoneToken = mintAuthority(
  { mesh: MESH, subject: "user:alice", bound: ALICE_PHONE, roles: ["app:editor"], expiresAt: SOON },
  HUB.getPrivateKey(),
);
scenario("T10-19", "A-21 revoking ONE binding denies that device", "deny", () =>
  verify(phoneToken, base({ connectionPeer: ALICE_PHONE, revoked: { bindings: [ALICE_PHONE] } })));

scenario("T10-20", "A-21 ... and leaves the same subject's other device working", "allow", () =>
  verify(aliceToken, base({ revoked: { bindings: [ALICE_PHONE] } })));

scenario("T10-21", "A-21 revoking the SUBJECT denies every device", "deny", () =>
  verify(aliceToken, base({ revoked: { subjects: ["user:alice"] } })));

// ------------------------------------------------------- A-25 evaluation budget
const explode = [
  ...Array.from({ length: 120 }, (_, i) => `item(${i});`),
  "pair($a, $b) <- item($a), item($b);",
];
scenario("T10-22", "A-25 a rule set that explodes denies rather than hangs", "deny", () =>
  verify(aliceToken, base({
    extraFacts: explode,
    limits: { max_facts: 500, max_iterations: 100, max_time_micro: 1_000_000 },
  })));

// -------------------------------------------------------------- A-19 no transport
const here = dirname(fileURLToPath(import.meta.url));
const TRANSPORT = /(libp2p|multiaddr|chainsafe|webrun-streams|node:net|node:dgram)/;
const offenders = readdirSync(here)
  .filter((f) => f.endsWith(".ts"))
  .flatMap((f) =>
    readFileSync(join(here, f), "utf8")
      .split("\n")
      .map((line, i) => ({ f, i: i + 1, line }))
      .filter(({ line }) => /^\s*import\b/.test(line) && TRANSPORT.test(line)),
  );
const clean = offenders.length === 0;
clean ? pass++ : fail++;
console.log(`\n${clean ? "PASS" : "FAIL"}  T10-23  A-19 block A runs with no transport present`);
console.log(`      scanned ${readdirSync(here).filter((f) => f.endsWith(".ts")).length} source file(s) for transport imports`);
for (const o of offenders) console.log(`      offender -> ${o.f}:${o.i} ${o.line.trim()}`);

// ------------------------------------------------------------------------- summary
console.log(`\n${"=".repeat(78)}`);
console.log(`${pass} passed, ${fail} failed   (limits ${JSON.stringify(LIMITS)})`);
console.log("=".repeat(78));
if (fail > 0) process.exitCode = 1;
