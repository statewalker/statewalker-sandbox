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
 * The token half follows prototype 10, including its two hard-won findings: the
 * default evaluation limits are unusable, and delegation must be a THIRD-PARTY block
 * scoped with `trusting` because a plain appended block attests to nothing.
 */
import {
  AuthorizerBuilder,
  Biscuit,
  BlockBuilder,
  KeyPair,
  PublicKey,
  SignatureAlgorithm,
  biscuit,
  block,
} from "@biscuit-auth/biscuit-wasm";
import type {
  FetchHandler,
  Implementation,
  MintInit,
  MountsTable,
  PolicySource,
  VerifyContext,
  VerifyOutcome,
} from "../src/types.js";

const LIMITS = { max_facts: 5_000, max_iterations: 200, max_time_micro: 1_000_000 };

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

function warmUp(): void {
  // Prototype 10, finding F2: the first authorization in a process throws a
  // spurious Timeout regardless of max_time_micro. Absorb it on a disposable key.
  const k = new KeyPair(SignatureAlgorithm.Ed25519);
  const t = biscuit`w(true); check if time($t), $t < 2100-01-01T00:00:00Z;`.build(k.getPrivateKey());
  const parsed = Biscuit.fromBase64(t.toBase64(), k.getPublicKey());
  for (let i = 0; i < 3; i++) {
    const a = new AuthorizerBuilder();
    a.addCode("time(2000-01-01T00:00:00Z); allow if w(true);");
    try {
      a.buildAuthenticated(parsed).authorizeWithLimits(LIMITS);
      return;
    } catch {
      /* the defect this exists for */
    }
  }
}

const iso = (d: Date): string => d.toISOString().replace(/\.\d{3}Z$/, "Z");

function mint(init: MintInit, meshKey: KeyPair): string {
  const b = init.delegationKey
    ? biscuit`check if bound($k), connection_peer($k)
              or delegate($k), connection_peer($k) trusting ${init.delegationKey as PublicKey};`
    : biscuit`check if bound($k), connection_peer($k);`;
  b.addCode(`mesh("${init.mesh}"); subject("${init.subject}"); bound("${init.bound}");`);
  for (const r of init.roles) b.addCode(`role("${r}");`);
  if (init.audience && init.audience.length > 0) {
    for (const a of init.audience) b.addCode(`audience("${a}");`);
    b.addCode("check if audience($k), self_peer($k);");
  } else {
    // A predicate takes at least one term, so the explicit state carries one.
    b.addCode("audience_unrestricted(true); check if audience_unrestricted(true);");
  }
  b.addCode(`check if time($t), $t < ${iso(init.expiresAt)};`);
  for (const c of init.extraChecks ?? []) b.addCode(c);
  return b.build(meshKey.getPrivateKey()).toBase64();
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

function declaresReserved(token: Biscuit): string[] {
  const found = new Set<string>();
  for (let i = 0; i < token.countBlocks(); i++) {
    const src = token.getBlockSource(i);
    for (const p of RESERVED) {
      // a FACT declaration, not a reference inside a check/rule body
      if (new RegExp(String.raw`^\s*${p}\s*\(`, "m").test(src)) found.add(p);
    }
  }
  return [...found];
}

function verify(
  token: string,
  meshPublic: PublicKey,
  ctx: VerifyContext,
  rules: PolicySource,
): VerifyOutcome {
  let parsed: Biscuit;
  try {
    parsed = Biscuit.fromBase64(token, meshPublic);
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
  const a = new AuthorizerBuilder();
  a.addCode(`connection_peer("${ctx.connectionPeer}"); self_peer("${ctx.selfPeer}"); time(${iso(ctx.now)});`);
  a.addCode(`operation("${ctx.operation}"); resource("${ctx.resource}");`);
  for (const [t, v] of ctx.selfFacts ?? []) a.addCode(`self_fact("${t}", "${v}");`);
  for (const f of ctx.extraFacts ?? []) a.addCode(f);
  for (const s of ctx.revokedSubjects ?? []) a.addCode(`revoked_subject("${s}");`);
  for (const k of ctx.revokedBindings ?? []) a.addCode(`revoked_binding("${k}");`);
  for (const r of rules.rules) a.addCode(r);
  a.addCode("deny if subject($s), revoked_subject($s);");
  a.addCode("deny if bound($k), revoked_binding($k);");
  for (const p of rules.policies) a.addCode(p);

  const limits = ctx.budget
    ? { max_facts: ctx.budget.maxFacts, max_iterations: ctx.budget.maxIterations, max_time_micro: ctx.budget.maxTimeMicro }
    : LIMITS;
  try {
    a.buildAuthenticated(parsed).authorizeWithLimits(limits);
    return { allowed: true };
  } catch (e) {
    const budgetExceeded = typeof e === "object" && e !== null && "RunLimit" in (e as object);
    return { allowed: false, budgetExceeded, failed: failedChecks(e) };
  }
}

function failedChecks(e: unknown): string[] {
  const checks = (e as { FailedLogic?: { Unauthorized?: { checks?: unknown[] } } })?.FailedLogic?.Unauthorized?.checks;
  if (!Array.isArray(checks)) return [JSON.stringify(e)];
  return checks.map((c) => {
    const b = (c as { Block?: { block_id: number; check_id: number; rule: string } }).Block;
    return b ? `block ${b.block_id} check ${b.check_id}: ${b.rule}` : JSON.stringify(c);
  });
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
    warmUp,
    async newMeshKey() { return new KeyPair(SignatureAlgorithm.Ed25519); },
    async newDeviceKey() { return new KeyPair(SignatureAlgorithm.Ed25519); },
    publicOf(key) { return (key as KeyPair).getPublicKey(); },
    async mint(init, meshKey) { return mint(init, meshKey as KeyPair); },
    async verify(token, meshPublic, ctx, rules) { return verify(token, meshPublic as PublicKey, ctx, rules); },
    async attenuate(token, meshPublic, constraints) {
      const t = Biscuit.fromBase64(token, meshPublic as PublicKey);
      const bb = new BlockBuilder();
      for (const c of constraints) bb.addCode(c);
      return t.appendBlock(bb).toBase64();
    },
    async delegate(token, meshPublic, holderKey, to, restrict) {
      const t = Biscuit.fromBase64(token, meshPublic as PublicKey);
      const bb = block`delegate(${to});`;
      for (const c of restrict) bb.addCode(c);
      const holder = holderKey as KeyPair;
      const tp = t.getThirdPartyRequest().createBlock(holder.getPrivateKey(), bb);
      return t.appendThirdPartyBlock(holder.getPublicKey(), tp).toBase64();
    },
    async forgeDelegation(token, meshPublic, to) {
      // The attack: a plain block anyone holding the token can append.
      return Biscuit.fromBase64(token, meshPublic as PublicKey).appendBlock(block`delegate(${to});`).toBase64();
    },
  },
};
