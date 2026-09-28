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
  type AuthorizationResult,
  Biscuit,
  generateKeypair,
  type RunLimits,
  thirdPartyBlock,
} from "@statewalker/webrun-biscuit";

/**
 * Evaluation budget (spec P9). Its shape is kept from the wasm era, where finding
 * F1 made it mandatory; the TypeScript engine takes it as `RunLimits`.
 */
export const LIMITS = { max_facts: 5_000, max_iterations: 200, max_time_micro: 1_000_000 };

const toRunLimits = (l: typeof LIMITS): RunLimits => ({
  maxFacts: l.max_facts,
  maxIterations: l.max_iterations,
  maxTimeMs: l.max_time_micro / 1000,
});

export type PeerKeyId = string;
export type SubjectId = string;
export type MeshId = string;

const hex = (bytes: Uint8Array): string =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

/** An Ed25519 public key; prints the way Biscuit source spells it in `trusting`. */
export class PublicKey {
  constructor(readonly bytes: Uint8Array) {}
  toString(): string {
    return `ed25519/${hex(this.bytes)}`;
  }
}

export class PrivateKey {
  constructor(readonly bytes: Uint8Array) {}
}

export class KeyPair {
  private readonly pair = generateKeypair();
  getPublicKey(): PublicKey {
    return new PublicKey(this.pair.publicKey);
  }
  getPrivateKey(): PrivateKey {
    return new PrivateKey(this.pair.secretKey);
  }
}

export const newKeyPair = (): KeyPair => new KeyPair();

/**
 * A no-op on the TypeScript engine. README finding F2 recorded that biscuit-wasm's
 * first authorization in a process threw a spurious `Timeout`; that was a defect of
 * the wasm build's clock, and it has nothing to absorb here.
 */
export function warmUp(_attempts = 3): void {}

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
  // Every value is a `{name}` PARAMETER, bound as a term. The wasm version spliced
  // them into source text; the public key in `trusting` is the one exception, since
  // a key is not a term and its hex spelling carries no Datalog syntax.
  const params: Record<string, string | Date> = {
    mesh: init.mesh,
    subject: init.subject,
    bound: init.bound,
    expiresAt: init.expiresAt,
  };
  const code: string[] = [
    init.delegationKey
      ? `check if bound($k), connection_peer($k) or delegate($k), connection_peer($k) trusting ${init.delegationKey};`
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
    // Biscuit predicates take at least one term: `audience_unrestricted()` is a
    // parse error, so the explicit state carries a term.
    code.push("audience_unrestricted(true);");
    code.push("check if audience_unrestricted(true);");
  }

  code.push("check if time($t), $t < {expiresAt};");
  for (const c of init.extraChecks ?? []) code.push(c);
  return Biscuit.build(rootKey.bytes, code.join("\n"), { params }).toBase64();
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
  const token = Biscuit.fromBase64(tokenB64);
  token.verify(root.bytes);
  const block = thirdPartyBlock(
    token.thirdPartyRequest(),
    holder.getPrivateKey().bytes,
    ["delegate({to});", ...(opts.restrict ?? [])].join("\n"),
    0,
    { to: opts.to },
  );
  return token.appendThirdParty(block).toBase64();
}
/**
 * The ATTACK: anyone holding the token bytes can append a plain block. Biscuit signs
 * appended blocks with a next-key that travels WITH the token, so a plain block
 * attests to nothing about who wrote it. Used to prove the `trusting` scope is what
 * makes delegation safe.
 */
export function forgeDelegation(tokenB64: string, root: PublicKey, to: PeerKeyId): string {
  const token = Biscuit.fromBase64(tokenB64);
  token.verify(root.bytes);
  return token.attenuate("delegate({to});", { params: { to } }).toBase64();
}
/** A holder narrowing its own token, with no delegation involved. */
export function attenuate(tokenB64: string, root: PublicKey, checks: string[]): string {
  const token = Biscuit.fromBase64(tokenB64);
  token.verify(root.bytes);
  return token.attenuate(checks.join("\n")).toBase64();
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
  let token: ReturnType<Biscuit["verify"]>;
  try {
    token = Biscuit.fromBase64(tokenB64).verify(ctx.root.bytes);
  } catch (e) {
    return { allowed: false, signatureError: describe(e) };
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
  (ctx.revoked?.subjects ?? []).forEach((s, i) => {
    params[`revokedSubject${i}`] = s;
    code.push(`revoked_subject({revokedSubject${i}});`);
  });
  (ctx.revoked?.bindings ?? []).forEach((k, i) => {
    params[`revokedBinding${i}`] = k;
    code.push(`revoked_binding({revokedBinding${i}});`);
  });
  for (const r of ctx.rules ?? []) code.push(r);

  // Deny policies first: policies are evaluated in order and the first match wins.
  code.push("deny if subject($s), revoked_subject($s);");
  code.push("deny if bound($k), revoked_binding($k);");
  for (const p of ctx.policies ?? []) code.push(p);

  const { result } = token.evaluate(code.join("\n"), {
    limits: toRunLimits(ctx.limits ?? LIMITS),
    params,
  });
  if (result.kind === "ok") return { allowed: true, policy: result.policy };
  return { allowed: false, failed: failedChecks(result), budgetExceeded: isRunLimit(result) };
}

/** The three limits that count work or time; other execution errors are not a budget. */
function isRunLimit(result: AuthorizationResult): boolean {
  return (
    result.kind === "execution" &&
    ["TooManyFacts", "TooManyIterations", "Timeout"].includes(result.error)
  );
}

/** Every failed check, with its block id and rule text (spec P8). */
function failedChecks(result: AuthorizationResult): string[] {
  if (result.kind === "execution") return [JSON.stringify({ RunLimit: result.error })];
  if (result.kind !== "unauthorized" && result.kind !== "noMatchingPolicy") {
    return [JSON.stringify(result)];
  }
  // As in the wasm version: only an unauthorized result lists checks (a matched
  // `deny` names itself through `policy`); anything else is described whole, so a
  // denial never reaches the caller as a bare boolean.
  if (result.kind === "noMatchingPolicy") return [JSON.stringify(result)];
  return result.checks.map((c) =>
    c.source === "block"
      ? `block ${c.blockId} check ${c.checkId}: ${c.rule}`
      : `authorizer check ${c.checkId}: ${c.rule}`,
  );
}

function describe(e: unknown): string {
  if (e instanceof Error) return e.message;
  return JSON.stringify(e);
}
