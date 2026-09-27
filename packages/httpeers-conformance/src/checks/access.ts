/** Block A — access and trust: tokens, binding, policy, revocation. */
import {
  type Check,
  type Implementation,
  type MintInit,
  NotImplemented,
  type PolicySource,
  type TokenCapability,
  type VerifyContext,
  type VerifyOutcome,
} from "../types.js";

const MESH = "mesh:H";
const ALICE = "peerkey:alice-laptop";
const PHONE = "peerkey:alice-phone";
const THIEF = "peerkey:thief";
const PROXY = "peerkey:proxy";
const SERVER = "peerkey:server";
const OTHER = "peerkey:other";
const NOW = new Date("2026-08-21T12:00:00Z");
const SOON = new Date("2026-08-21T13:00:00Z");
const PAST = new Date("2026-08-21T11:00:00Z");

export const RULES: PolicySource = {
  rules: [
    'capability("app:notes.read")  <- role("app:reader");',
    'capability("app:notes.write") <- role("app:editor");',
    'role("app:reader")            <- role("app:editor");',
  ],
  policies: [
    'allow if resource($r), $r.starts_with("/notes"), operation("GET"), capability("app:notes.read");',
    'allow if resource($r), $r.starts_with("/notes"), operation("PUT"), capability("app:notes.write");',
  ],
};

const tok = (impl: Implementation): TokenCapability => {
  if (!impl.tokens) throw new NotImplemented("no `tokens` capability");
  return impl.tokens;
};
const assert = (cond: unknown, msg: string): void => {
  if (!cond) throw new Error(msg);
};

interface Fixture {
  t: TokenCapability;
  mesh: unknown;
  meshPub: unknown;
  device: unknown;
  mint(over?: Partial<MintInit>): Promise<string>;
  check(token: string, over?: Partial<VerifyContext>, rules?: PolicySource): Promise<VerifyOutcome>;
}

async function fixture(impl: Implementation): Promise<Fixture> {
  const t = tok(impl);
  t.warmUp?.();
  const mesh = await t.newMeshKey();
  const meshPub = t.publicOf(mesh);
  const device = await t.newDeviceKey();
  const base: MintInit = {
    mesh: MESH,
    subject: "user:alice",
    bound: ALICE,
    roles: ["app:editor"],
    expiresAt: SOON,
  };
  return {
    t,
    mesh,
    meshPub,
    device,
    mint: (over = {}) => t.mint({ ...base, ...over }, mesh),
    check: (token, over = {}, rules = RULES) =>
      t.verify(
        token,
        meshPub,
        {
          connectionPeer: ALICE,
          selfPeer: SERVER,
          now: NOW,
          operation: "GET",
          resource: "/notes/2026-08-21",
          ...over,
        },
        rules,
      ),
  };
}

const denied = (r: VerifyOutcome, why: string): void =>
  assert(!r.allowed, `${why} — it was ALLOWED`);
const allowed = (r: VerifyOutcome, why: string): void =>
  assert(r.allowed, `${why} — it was denied (${(r.failed ?? []).join("; ") || "no reason given"})`);

export const ACCESS_CHECKS: Record<string, Check | { skip: string }> = {
  "A-01": async (impl) => {
    const f = await fixture(impl);
    denied(
      await f.check(await f.mint(), { operation: "DELETE" }),
      "nothing grants DELETE, so nothing may permit it",
    );
  },

  "A-02": async (impl) => {
    const f = await fixture(impl);
    // A reader may read and must not write. Both halves, or the claim is untested.
    const reader = await f.mint({ roles: ["app:reader"] });
    allowed(await f.check(reader, { operation: "GET" }), "a reader could not read");
    denied(await f.check(reader, { operation: "PUT" }), "a reader could write — privilege creep");
  },

  "A-03": {
    skip: "the forged-header path needs an HTTP surface; established by prototype 03 over real nodes",
  },

  "A-04": async (impl) => {
    const f = await fixture(impl);
    // The token asserts the NODE's fact. If the implementation lets a token supply
    // `connection_peer`, the token satisfies its own binding check and the binding
    // rule is worthless. The node's fact set must be authoritative.
    const selfDealing = await f.mint({
      bound: ALICE,
      extraChecks: [`connection_peer("${ALICE}");`],
    });
    denied(
      await f.check(selfDealing, { connectionPeer: THIEF }),
      "a token asserted its own connection_peer and satisfied its own binding check",
    );
  },

  "A-05": async (impl) => {
    const f = await fixture(impl);
    const r = await f.check(
      await f.mint(),
      {},
      {
        rules: RULES.rules,
        policies: ['deny if operation("GET");', ...RULES.policies],
      },
    );
    denied(r, "an explicit deny did not beat a matching allow");
  },

  "A-06": async (impl) => {
    const f = await fixture(impl);
    const bad = await f.check(await f.mint(), { connectionPeer: THIEF });
    denied(bad, "binding mismatch");
    assert(
      (bad.failed ?? []).length > 0,
      "a denial named no failing check (spec P8: a bare boolean is not a decision)",
    );
  },

  "A-07": async (impl) => {
    const f = await fixture(impl);
    denied(
      await f.check(await f.mint({ roles: ["app:nobody-defined-this"] })),
      "an unknown role granted something — there must be no fallback",
    );
  },

  "A-08": async (impl) => {
    const f = await fixture(impl);
    // editor implies reader implies the read capability: two hops, never stated directly.
    allowed(
      await f.check(await f.mint({ roles: ["app:editor"] }), { operation: "GET" }),
      "role implication was not transitive",
    );
  },

  "A-09": {
    skip: "namespace validation is a rule-set build concern; exercised by A-10 once a `policy` capability validates roles",
  },

  "A-10": async (impl) => {
    if (!impl.policy) throw new NotImplemented("no `policy` capability to validate a rule set");
    let msg = "";
    try {
      impl.policy.build({
        rules: [],
        policies: [
          'allow if capability("app:never-derived");',
          'allow if capability("app:also-never");',
        ],
      });
    } catch (e) {
      msg = e instanceof Error ? e.message : String(e);
    }
    assert(msg, "a policy naming capabilities no rule can derive was accepted");
    assert(
      msg.includes("app:never-derived") && msg.includes("app:also-never"),
      `the error named only some of the problems: ${msg}`,
    );
  },

  "A-11": async (impl) => {
    const f = await fixture(impl);
    denied(
      await f.check(await f.mint(), { connectionPeer: THIEF }),
      "a token was accepted over a connection it was not bound to",
    );
  },

  "A-12": async (impl) => {
    const f = await fixture(impl);
    // The server received Alice's token; it may not present it onward as itself.
    denied(
      await f.check(await f.mint(), { connectionPeer: SERVER, selfPeer: OTHER }),
      "a peer replayed a token it had merely received",
    );
  },

  "A-13": async (impl) => {
    const f = await fixture(impl);
    if (!f.t.forgeDelegation)
      throw new NotImplemented("no `forgeDelegation` to exercise the un-permitted path");
    const noPermission = await f.mint(); // minted WITHOUT a delegation key
    const attenuated = await f.t.forgeDelegation(noPermission, f.meshPub, PROXY);
    denied(
      await f.check(attenuated, { connectionPeer: PROXY }),
      "a token whose authority block permitted no delegation was delegated anyway",
    );
  },

  "A-13b": async (impl) => {
    const f = await fixture(impl);
    if (!f.t.forgeDelegation || !f.t.delegate)
      throw new NotImplemented("needs both `forgeDelegation` and `delegate`");
    const delegable = await f.mint({ delegationKey: f.t.publicOf(f.device) });
    // Both halves are required. The forged one passing is the escalation; the signed
    // one failing means the mechanism does not work at all.
    const forged = await f.t.forgeDelegation(delegable, f.meshPub, THIEF);
    denied(
      await f.check(forged, { connectionPeer: THIEF }),
      "a PLAIN appended block yielded authority — anyone holding the token can delegate to themselves",
    );
    const signed = await f.t.delegate(delegable, f.meshPub, f.device, PROXY, [
      'check if operation("GET");',
    ]);
    allowed(
      await f.check(signed, { connectionPeer: PROXY }),
      "a holder-signed third-party delegation was refused",
    );
    denied(
      await f.check(signed, { connectionPeer: PROXY, operation: "PUT" }),
      "the delegation did not narrow: the delegate could PUT",
    );
  },

  "A-14": async (impl) => {
    const f = await fixture(impl);
    denied(await f.check(await f.mint({ expiresAt: PAST })), "an expired token was accepted");
  },

  "A-15": async (impl) => {
    const f = await fixture(impl);
    const otherMesh = await f.t.newMeshKey();
    const r = await f.t.verify(
      await f.mint(),
      f.t.publicOf(otherMesh),
      {
        connectionPeer: ALICE,
        selfPeer: SERVER,
        now: NOW,
        operation: "GET",
        resource: "/notes/x",
      },
      RULES,
    );
    denied(r, "a token verified against a different mesh key");
    assert(
      r.signatureError,
      "the failure was logical, not cryptographic — the signature was not checked",
    );
  },

  "A-16": {
    skip: "needs a `directory` capability; no implementation resolves issuer keys through one yet",
  },
  "A-17": { skip: "needs a `directory` capability supporting a rotation overlap window" },

  "A-18": async (impl) => {
    const f = await fixture(impl);
    const t = await f.mint();
    allowed(await f.check(t), "the token did not work before revocation");
    denied(
      await f.check(t, { revokedSubjects: ["user:alice"] }),
      "a revoked subject was still accepted",
    );
  },

  "A-19": {
    skip: "asserted by `tests/dependency-graph.test.ts`, which reads manifests rather than calling the implementation",
  },

  "A-20": async (impl) => {
    const f = await fixture(impl);
    const future = await f.mint({ extraChecks: ["check if quantum_safe(true);"] });
    denied(
      await f.check(future),
      "a constraint the verifier has never heard of was IGNORED rather than refused",
    );
    allowed(
      await f.check(future, { extraFacts: ["quantum_safe(true);"] }),
      "supplying the predicate did not satisfy the constraint",
    );
  },

  "A-21": async (impl) => {
    const f = await fixture(impl);
    const laptop = await f.mint({ bound: ALICE });
    const phone = await f.mint({ bound: PHONE });
    denied(
      await f.check(phone, { connectionPeer: PHONE, revokedBindings: [PHONE] }),
      "revoking a binding did not withdraw that device",
    );
    allowed(
      await f.check(laptop, { revokedBindings: [PHONE] }),
      "revoking one device withdrew the subject's other device too",
    );
  },

  "A-22": { skip: "needs a `pinnedMesh` capability with a signed succession chain (ADR-0018)" },

  "A-23": async (impl) => {
    const f = await fixture(impl);
    if (!f.t.attenuate) throw new NotImplemented("no `attenuate` capability");
    const widened = await f.t.attenuate(await f.mint({ roles: ["app:reader"] }), f.meshPub, [
      'role("app:editor");',
    ]);
    denied(
      await f.check(widened, { operation: "PUT" }),
      "an appended block granted a role the hub never issued",
    );
    // Control: the same policy must ALLOW when the hub granted it, or the check above
    // proves nothing — a policy that can never match denies for the wrong reason.
    allowed(
      await f.check(await f.mint({ roles: ["app:editor"] }), { operation: "PUT" }),
      "control failed: the policy never matches even for a legitimately granted role",
    );
  },

  "A-24": async (impl) => {
    const f = await fixture(impl);
    const scoped = await f.mint({ audience: [SERVER] });
    allowed(
      await f.check(scoped, { selfPeer: SERVER }),
      "an audience-scoped token failed at its intended destination",
    );
    denied(
      await f.check(scoped, { selfPeer: OTHER }),
      "a token was accepted by a peer outside its audience — the destination did not enforce it",
    );
  },

  "A-25": async (impl) => {
    const f = await fixture(impl);
    const explode = [
      ...Array.from({ length: 120 }, (_, i) => `item(${i});`),
      "pair($a, $b) <- item($a), item($b);",
    ];
    const r = await f.check(await f.mint(), {
      extraFacts: explode,
      budget: { maxFacts: 500, maxIterations: 100, maxTimeMicro: 1_000_000 },
    });
    denied(r, "a rule set that explodes was evaluated to completion rather than refused");
    assert(r.budgetExceeded, "the denial was not attributed to the evaluation budget (spec P9)");
  },
};
