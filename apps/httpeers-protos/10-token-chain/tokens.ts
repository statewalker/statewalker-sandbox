/**
 * The httpeers token contract, expressed over Biscuit.
 *
 * This is a RECONSTRUCTION of the API specified in
 * `docs/superpowers/specs/2026-08-20-httpeers-api-design.md` §6.3, not recovered
 * code — nothing in the shipped packages mints or verifies a token yet. It exists
 * so the mint -> attenuate -> verify chain can be exercised against real keys.
 *
 * NOTHING HERE IMPORTS A TRANSPORT. That is criterion A-19 and it is checked
 * mechanically by `main.ts`, not merely intended.
 */
import {
  AuthorizerBuilder,
  Biscuit,
  BlockBuilder,
  biscuit,
  block,
  KeyPair,
  type PrivateKey,
  type PublicKey,
  SignatureAlgorithm,
} from "@biscuit-auth/biscuit-wasm";

/**
 * Evaluation budget (spec P9).
 *
 * NOT optional, and not merely a hardening measure: `Authorizer.authorize()` with
 * this build's DEFAULT limits throws `{ RunLimit: 'Timeout' }` on a single-fact
 * policy. Every call therefore goes through `authorizeWithLimits`. See the README,
 * finding F1.
 */
export const LIMITS = { max_facts: 5_000, max_iterations: 200, max_time_micro: 1_000_000 };

export type PeerKeyId = string;
export type SubjectId = string;
export type MeshId = string;

export const newKeyPair = (): KeyPair => new KeyPair(SignatureAlgorithm.Ed25519);

/**
 * Absorb the first authorization in a process. MANDATORY — see README finding F2.
 *
 * In `@biscuit-auth/biscuit-wasm@0.6.0` the TIME-based run limit is unreliable: the
 * first `authorizeWithLimits` call in a process throws `{ RunLimit: 'Timeout' }`
 * REGARDLESS of `max_time_micro`. Measured: it fires identically at 1_000 and at
 * 1_000_000_000 (≈1000 s) while the call itself takes ~30 ms of one-time warm-up.
 * The limit is not being honoured; the clock underneath it is wrong under WASM.
 *
 * The fact and iteration limits are unaffected and do work (see T10-22).
 *
 * This throws away one authorization on a disposable key so that no real request
 * pays for it. A peer must call this at start-up, or its first authorized request
 * fails closed for no reason.
 */
export function warmUp(attempts = 3): void {
  const k = newKeyPair();
  const t = biscuit`w(true); check if time($t), $t < 2100-01-01T00:00:00Z;`.build(
    k.getPrivateKey(),
  );
  const parsed = Biscuit.fromBase64(t.toBase64(), k.getPublicKey());
  for (let i = 0; i < attempts; i++) {
    const a = new AuthorizerBuilder();
    a.addCode("time(2000-01-01T00:00:00Z); allow if w(true);");
    try {
      a.buildAuthenticated(parsed).authorizeWithLimits(LIMITS);
      return;
    } catch {
      /* the defect this function exists for; retry */
    }
  }
}

export interface AuthorityInit {
  mesh: MeshId;
  subject: SubjectId;
  /** The transport key this token is bound to — the confirmation (ADR-0009). */
  bound: PeerKeyId;
  roles: string[];
  expiresAt: Date;
  /** Omit for an unrestricted audience, which is an EXPLICIT state (ADR-0020). */
  audience?: PeerKeyId[];
  /**
   * The holder's own device public key. Its PRESENCE is what permits delegation,
   * and the authority check scopes the delegate fact to blocks signed by this key
   * (`trusting`). Omit and delegation is impossible — deny by default expressed in
   * the format rather than in policy (ADR-0010).
   */
  delegationKey?: PublicKey;
  /** Extra checks, for exercising the unknown-constraint path. */
  extraChecks?: string[];
}

/** The hub mints. Only the hub's key signs an authority block. */
export function mintAuthority(init: AuthorityInit, rootKey: PrivateKey): string {
  const b = init.delegationKey
    ? biscuit`check if bound($k), connection_peer($k)
              or delegate($k), connection_peer($k) trusting ${init.delegationKey};`
    : biscuit`check if bound($k), connection_peer($k);`;

  b.addCode(`mesh("${init.mesh}"); subject("${init.subject}"); bound("${init.bound}");`);
  for (const r of init.roles) b.addCode(`role("${r}");`);

  if (init.audience && init.audience.length > 0) {
    for (const a of init.audience) b.addCode(`audience("${a}");`);
    b.addCode("check if audience($k), self_peer($k);");
  } else {
    // Biscuit predicates take at least one term: `audience_unrestricted()` is a
    // parse error, so the explicit state carries a term.
    b.addCode("audience_unrestricted(true);");
    b.addCode("check if audience_unrestricted(true);");
  }

  b.addCode(`check if time($t), $t < ${init.expiresAt.toISOString().replace(/\.\d{3}Z$/, "Z")};`);
  for (const c of init.extraChecks ?? []) b.addCode(c);
  return b.build(rootKey).toBase64();
}

/**
 * DELEGATION, done correctly: a THIRD-PARTY block signed by the holder's own device
 * key, which the authority check scopes with `trusting`.
 *
 * Plain `appendBlock` is NOT sufficient here and `forgeDelegation` below proves why.
 */
export function delegateTo(
  tokenB64: string,
  root: PublicKey,
  holder: KeyPair,
  opts: { to: PeerKeyId; restrict?: string[] },
): string {
  const token = Biscuit.fromBase64(tokenB64, root);
  const bb = block`delegate(${opts.to});`;
  for (const c of opts.restrict ?? []) bb.addCode(c);
  const tp = token.getThirdPartyRequest().createBlock(holder.getPrivateKey(), bb);
  return token.appendThirdPartyBlock(holder.getPublicKey(), tp).toBase64();
}

/**
 * The ATTACK: anyone holding the token bytes can append a plain block. Biscuit signs
 * appended blocks with a next-key that travels WITH the token, so a plain block
 * attests to nothing about who wrote it. Used to prove the `trusting` scope is what
 * makes delegation safe.
 */
export function forgeDelegation(tokenB64: string, root: PublicKey, to: PeerKeyId): string {
  return Biscuit.fromBase64(tokenB64, root).appendBlock(block`delegate(${to});`).toBase64();
}

/** A holder narrowing its own token, with no delegation involved. */
export function attenuate(tokenB64: string, root: PublicKey, checks: string[]): string {
  const token = Biscuit.fromBase64(tokenB64, root);
  const bb = new BlockBuilder();
  for (const c of checks) bb.addCode(c);
  return token.appendBlock(bb).toBase64();
}

export interface RevocationSnapshot {
  subjects?: SubjectId[];
  bindings?: PeerKeyId[];
}

export interface VerifyContext {
  root: PublicKey;
  /** What the transport proved. Asserted by the NODE, never read from the token. */
  connectionPeer: PeerKeyId;
  selfPeer: PeerKeyId;
  selfFacts?: [string, string][];
  now: Date;
  operation: string;
  resource: string;
  /** Capability derivation — the vocabulary as rules (ADR-0016 amendment). */
  rules?: string[];
  policies?: string[];
  revoked?: RevocationSnapshot;
  limits?: typeof LIMITS;
  /** Extra facts, for the evaluation-budget scenario. */
  extraFacts?: string[];
}

export interface VerifyResult {
  allowed: boolean;
  /** Index of the matching allow policy. */
  policy?: number;
  /** Every failed check, with block id and the rule text (spec P8). */
  failed?: string[];
  /** Set when the failure was cryptographic rather than logical. */
  signatureError?: string;
  /** Set when the evaluation budget was exhausted (P9). */
  budgetExceeded?: boolean;
}

export function verify(tokenB64: string, ctx: VerifyContext): VerifyResult {
  let token: Biscuit;
  try {
    token = Biscuit.fromBase64(tokenB64, ctx.root);
  } catch (e) {
    return { allowed: false, signatureError: describe(e) };
  }

  const a = new AuthorizerBuilder();
  const iso = ctx.now.toISOString().replace(/\.\d{3}Z$/, "Z");
  a.addCode(
    `connection_peer("${ctx.connectionPeer}"); self_peer("${ctx.selfPeer}"); time(${iso});`,
  );
  a.addCode(`operation("${ctx.operation}"); resource("${ctx.resource}");`);
  for (const [t, v] of ctx.selfFacts ?? []) a.addCode(`self_fact("${t}", "${v}");`);
  for (const f of ctx.extraFacts ?? []) a.addCode(f);
  for (const s of ctx.revoked?.subjects ?? []) a.addCode(`revoked_subject("${s}");`);
  for (const k of ctx.revoked?.bindings ?? []) a.addCode(`revoked_binding("${k}");`);
  for (const r of ctx.rules ?? []) a.addCode(r);

  // Deny policies first: policies are evaluated in order and the first match wins.
  a.addCode("deny if subject($s), revoked_subject($s);");
  a.addCode("deny if bound($k), revoked_binding($k);");
  for (const p of ctx.policies ?? []) a.addCode(p);

  try {
    return {
      allowed: true,
      policy: a.buildAuthenticated(token).authorizeWithLimits(ctx.limits ?? LIMITS),
    };
  } catch (e) {
    const budget = isRunLimit(e);
    return { allowed: false, failed: failedChecks(e), budgetExceeded: budget };
  }
}

function isRunLimit(e: unknown): boolean {
  return typeof e === "object" && e !== null && "RunLimit" in (e as object);
}

/** Pull `block_id` / `rule` out of biscuit's structured failure (spec P8). */
function failedChecks(e: unknown): string[] {
  const checks = (e as any)?.FailedLogic?.Unauthorized?.checks;
  if (!Array.isArray(checks)) return [describe(e)];
  return checks.map((c: any) => {
    const b = c?.Block;
    if (b) return `block ${b.block_id} check ${b.check_id}: ${b.rule}`;
    const auth = c?.Authorizer;
    if (auth) return `authorizer check ${auth.check_id}: ${auth.rule}`;
    return JSON.stringify(c);
  });
}

function describe(e: unknown): string {
  if (e instanceof Error) return e.message;
  return JSON.stringify(e);
}
