/**
 * A reference implementation of the specified API, for the parts this harness can
 * test: mount tables (block R), tokens and policy (block A), and the intermediary
 * transform (block X).
 *
 * Its purpose is to keep the suite honest in the other direction. A conformance
 * suite that nothing passes is indistinguishable from a suite whose checks are
 * wrong, so the spec needs at least one implementation that satisfies it. This is
 * also the natural seed for `@statewalker/httpeers.biscuit` when §13's
 * reconciliation happens.
 *
 * The token half follows prototype 10, including its hard-won finding that
 * delegation must be a THIRD-PARTY block scoped with `trusting`, because a plain
 * appended block attests to nothing. The engine is `@statewalker/webrun-biscuit`
 * (pure TypeScript); every value reaches Datalog as a `{name}` parameter.
 */
import {
  type AuthorizationResult,
  Biscuit,
  type Keypair,
  type LoadedToken,
  type RunLimits,
  evaluate,
  generateKeypair,
  thirdPartyBlock,
} from "@statewalker/webrun-biscuit";
import type {
  FetchHandler,
  Implementation,
  MintInit,
  MountsTable,
  PolicySource,
  VerifyContext,
  VerifyOutcome,
} from "../src/types.js";

const LIMITS: RunLimits = { maxFacts: 5_000, maxIterations: 200, maxTimeMs: 1_000 };

// ------------------------------------------------------------------ block R

const segments = (p: string): string[] => p.split("/").filter(Boolean);

/** Immutable, validated whole, and it reports EVERY conflict (ADR-0006, spec P5). */
function buildMounts(defs: Record<string, FetchHandler>): MountsTable {
  const problems: string[] = [];
  const seen = new Map<string, string>();
  for (const prefix of Object.keys(defs)) {
    if (!prefix.startsWith("/")) problems.push(`\`${prefix}\` must start with "/"`);
    if (prefix.length > 1 && prefix.endsWith("/")) {
      problems.push(
        `\`${prefix}\` has a trailing slash. There is one canonical spelling, so \`${prefix}\` ` +
          `and \`${prefix.slice(0, -1)}\` cannot both exist.`,
      );
    }
    const key = "/" + segments(prefix).join("/");
    const prior = seen.get(key);
    if (prior !== undefined) {
      problems.push(`\`${prefix}\` and \`${prior}\` resolve the same paths at the same depth`);
    } else {
      seen.set(key, prefix);
    }
  }
  if (problems.length > 0) {
    throw new Error(`invalid mount table:\n  - ${problems.join("\n  - ")}`);
  }
  const entries = Object.entries(defs)
    .map(([prefix, handler]) => ({ segs: segments(prefix), handler }))
    .sort((a, b) => b.segs.length - a.segs.length); // longest first; order-independent
  return {
    resolve(path: string): FetchHandler | null {
      const want = segments(path);
      for (const e of entries) {
        if (e.segs.every((s, i) => want[i] === s)) return e.handler;
      }
      return null;
    },
  };
}

// ------------------------------------------------------------------ block A

const hex = (bytes: Uint8Array): string =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

function mint(init: MintInit, meshKey: Keypair): string {
  const params: Record<string, string | Date> = {
    mesh: init.mesh,
    subject: init.subject,
    bound: init.bound,
    expiresAt: init.expiresAt,
  };
  const code: string[] = [
    init.delegationKey
      ? // A public key is not a term, so it cannot be a parameter; hex has no Datalog syntax.
        `check if bound($k), connection_peer($k) or delegate($k), connection_peer($k) trusting ed25519/${hex(init.delegationKey as Uint8Array)};`
      : "check if bound($k), connection_peer($k);",
    "mesh({mesh}); subject({subject}); bound({bound});",
  ];
  init.roles.forEach((r, i) => {
    params[`role${i}`] = r;
    code.push(`role({role${i}});`);
  });
  if (init.audience && init.audience.length > 0) {
    init.audience.forEach((a, i) => {
      params[`audience${i}`] = a;
      code.push(`audience({audience${i}});`);
    });
    code.push("check if audience($k), self_peer($k);");
  } else {
    // A predicate takes at least one term, so the explicit state carries one.
    code.push("audience_unrestricted(true); check if audience_unrestricted(true);");
  }
  code.push("check if time($t), $t < {expiresAt};");
  for (const c of init.extraChecks ?? []) code.push(c);
  return Biscuit.build(meshKey.secretKey, code.join("\n"), { params }).toBase64();
}

/**
 * Predicates the VERIFIER owns. A token may never declare one.
 *
 * Found by criterion A-04 on this suite's first run. Biscuit puts authority-block
 * facts and authorizer facts in one set, so a token carrying `connection_peer("X")`
 * satisfies its own `check if bound($k), connection_peer($k)` — the binding rule,
 * which is the load-bearing rule of the whole trust model, verifies against a fact
 * the token supplied.
 *
 * Appended blocks cannot reach this (Biscuit scopes their facts, confirmed
 * separately), so it is not member-exploitable. It is an unstated INVARIANT: the
 * authority block must never contain a predicate the verifier asserts. Enforcing it
 * here makes the invariant checked rather than assumed, which is what the spec's
 * A-04 already required.
 */
const RESERVED = [
  "connection_peer", "self_peer", "self_fact", "time",
  "operation", "resource", "revoked_subject", "revoked_binding",
];

function declaresReserved(token: LoadedToken): string[] {
  const found = new Set<string>();
  for (const block of token.blocks) {
    // a FACT declaration, or a rule deriving one — not a reference inside a body
    const declared = [...block.facts.map((f) => f.predicate.name), ...block.rules.map((r) => r.head.name)];
    for (const p of RESERVED) if (declared.includes(p)) found.add(p);
  }
  return [...found];
}

function verify(
  token: string,
  meshPublic: Uint8Array,
  ctx: VerifyContext,
  rules: PolicySource,
): VerifyOutcome {
  let parsed: LoadedToken;
  try {
    parsed = Biscuit.fromBase64(token).verify(meshPublic).token;
  } catch {
    return { allowed: false, signatureError: true, failed: ["signature verification failed"] };
  }
  const usurped = declaresReserved(parsed);
  if (usurped.length > 0) {
    return {
      allowed: false,
      failed: [`token declares verifier-owned predicate(s): ${usurped.join(", ")}`],
    };
  }
  const params: Record<string, string | Date> = {
    connectionPeer: ctx.connectionPeer,
    selfPeer: ctx.selfPeer,
    now: ctx.now,
    operation: ctx.operation,
    resource: ctx.resource,
  };
  const code: string[] = [
    "connection_peer({connectionPeer}); self_peer({selfPeer}); time({now});",
    "operation({operation}); resource({resource});",
  ];
  (ctx.selfFacts ?? []).forEach(([t, v], i) => {
    params[`selfType${i}`] = t;
    params[`selfValue${i}`] = v;
    code.push(`self_fact({selfType${i}}, {selfValue${i}});`);
  });
  for (const f of ctx.extraFacts ?? []) code.push(f);
  (ctx.revokedSubjects ?? []).forEach((s, i) => {
    params[`revokedSubject${i}`] = s;
    code.push(`revoked_subject({revokedSubject${i}});`);
  });
  (ctx.revokedBindings ?? []).forEach((k, i) => {
    params[`revokedBinding${i}`] = k;
    code.push(`revoked_binding({revokedBinding${i}});`);
  });
  for (const r of rules.rules) code.push(r);
  code.push("deny if subject($s), revoked_subject($s);");
  code.push("deny if bound($k), revoked_binding($k);");
  for (const p of rules.policies) code.push(p);

  const limits: RunLimits = ctx.budget
    ? { maxFacts: ctx.budget.maxFacts, maxIterations: ctx.budget.maxIterations, maxTimeMs: ctx.budget.maxTimeMicro / 1000 }
    : LIMITS;
  const { result } = evaluate(parsed, code.join("\n"), { limits, params });
  if (result.kind === "ok") return { allowed: true };
  const budgetExceeded =
    result.kind === "execution" && ["TooManyFacts", "TooManyIterations", "Timeout"].includes(result.error);
  return { allowed: false, budgetExceeded, failed: failedChecks(result) };
}

function failedChecks(result: AuthorizationResult): string[] {
  if (result.kind !== "unauthorized" && result.kind !== "noMatchingPolicy") return [JSON.stringify(result)];
  if (result.checks.length === 0) return [JSON.stringify(result)];
  return result.checks.map((c) =>
    c.source === "block" ? `block ${c.blockId} check ${c.checkId}: ${c.rule}` : `authorizer check ${c.checkId}: ${c.rule}`,
  );
}

// ------------------------------------------------------------------ block X

const HOP_BY_HOP = new Set([
  "connection", "keep-alive", "te", "transfer-encoding", "upgrade",
  "proxy-authenticate", "proxy-authorization", "trailer",
]);

function asIntermediary(req: Request, opts: { via: string; credentials?: Record<string, string> }): Request {
  const headers = new Headers(req.headers);
  // RFC 9110: everything the Connection header names is hop-by-hop too.
  for (const named of (headers.get("connection") ?? "").split(",")) {
    const n = named.trim().toLowerCase();
    if (n) headers.delete(n);
  }
  for (const h of HOP_BY_HOP) headers.delete(h);
  // The mesh's own credential is CONSUMED, never forwarded (ADR-0015).
  headers.delete("authorization");
  const host = new URL(req.url).host;
  const cred = opts.credentials?.[host];
  if (cred) headers.set("authorization", cred);
  headers.set("via", opts.via);
  return new Request(req.url, { method: req.method, headers });
}

// ------------------------------------------------------------------ adapter

export const referenceImplementation: Implementation = {
  name: "reference (spec-conformant)",
  notes: "Biscuit tokens + Datalog policy, per ADR-0019. The seed for @statewalker/httpeers.biscuit.",
  mounts: { build: buildMounts },
  policy: {
    build(source) {
      // Every capability a policy names must be derivable by some rule, and the
      // error lists all of them (spec P5, criterion A-10).
      const derivable = new Set<string>();
      for (const r of source.rules) {
        for (const m of r.matchAll(/capability\("([^"]+)"\)\s*<-/g)) derivable.add(m[1] as string);
      }
      const missing = new Set<string>();
      for (const p of source.policies) {
        for (const m of p.matchAll(/capability\("([^"]+)"\)/g)) {
          if (!derivable.has(m[1] as string)) missing.add(m[1] as string);
        }
      }
      if (missing.size > 0) {
        throw new Error(
          `policy names ${missing.size} capability(ies) no rule can derive: ${[...missing].join(", ")}`,
        );
      }
      return source;
    },
  },
  intermediary: { asIntermediary },
  tokens: {
    async newMeshKey() { return generateKeypair(); },
    async newDeviceKey() { return generateKeypair(); },
    publicOf(key) { return (key as Keypair).publicKey; },
    async mint(init, meshKey) { return mint(init, meshKey as Keypair); },
    async verify(token, meshPublic, ctx, rules) { return verify(token, meshPublic as Uint8Array, ctx, rules); },
    async attenuate(token, meshPublic, constraints) {
      const t = Biscuit.fromBase64(token);
      t.verify(meshPublic as Uint8Array);
      return t.attenuate(constraints.join("\n")).toBase64();
    },
    async delegate(token, meshPublic, holderKey, to, restrict) {
      const t = Biscuit.fromBase64(token);
      t.verify(meshPublic as Uint8Array);
      const holder = holderKey as Keypair;
      const block = thirdPartyBlock(t.thirdPartyRequest(), holder.secretKey, ["delegate({to});", ...restrict].join("\n"), 0, { to });
      return t.appendThirdParty(block).toBase64();
    },
    async forgeDelegation(token, meshPublic, to) {
      // The attack: a plain block anyone holding the token can append.
      const t = Biscuit.fromBase64(token);
      t.verify(meshPublic as Uint8Array);
      return t.attenuate("delegate({to});", { params: { to } }).toBase64();
    },
  },
};
