/**
 * The conformance contract.
 *
 * A criterion has FOUR possible outcomes, not two, and the distinction between the
 * middle pair is the entire point of this suite:
 *
 *   pass     the implementation satisfies the criterion
 *   fail     it offers the capability and behaves wrongly
 *   missing  it does not offer the capability at all — a DIVERGENCE from the spec
 *   skip     the criterion is not testable in this harness (needs a live transport,
 *            a running hub, or a browser edge), stated with a reason
 *
 * Collapsing `missing` into `fail` would report a package that never implemented
 * something as merely buggy; collapsing it into `skip` would hide it entirely. The
 * divergence list in §13 of the spec is exactly the set of `missing` outcomes.
 */

export interface Criterion {
  readonly id: string;
  readonly block: string;
  /** The spec's own words. Used verbatim as the test name (ADR-0003). */
  readonly claim: string;
  /** What observation would falsify it. */
  readonly falsifiedBy: string | null;
  /** The prototype backing it, when one does. */
  readonly evidence: string | null;
  /** True when the spec marks it as having no implementation behind it. */
  readonly designed: boolean;
}

export type FetchHandler = (req: Request) => Promise<Response>;

/** Thrown by a check when the implementation does not offer the capability. */
export class NotImplemented extends Error {
  constructor(what: string) {
    super(what);
    this.name = "NotImplemented";
  }
}

/** Thrown by a check that cannot run in this harness, with the reason. */
export class NotTestable extends Error {
  constructor(why: string) {
    super(why);
    this.name = "NotTestable";
  }
}

// ---------------------------------------------------------------- capabilities

export interface MountsTable {
  /**
   * The handler a path resolves to, or null when nothing matches.
   *
   * Deliberately NOT `{ handler, prefix, rest }`: an adapter whose implementation
   * does not expose the matched prefix would have to reconstruct it, and then the
   * checks would be testing the adapter's reconstruction rather than the
   * implementation's routing. Which handler ran is the observable that matters.
   */
  resolve(path: string): FetchHandler | null;
}

export interface MountsCapability {
  /**
   * Build a mount table. Per ADR-0006 this MUST validate the whole set and throw on
   * ambiguity, listing every conflict rather than the first.
   */
  build(defs: Record<string, FetchHandler>): MountsTable;
}

export interface VerifyContext {
  connectionPeer: string;
  selfPeer: string;
  now: Date;
  operation: string;
  resource: string;
  selfFacts?: [string, string][];
  revokedSubjects?: string[];
  revokedBindings?: string[];
  /** Facts the verifier supplies that a token's checks may reference. */
  extraFacts?: string[];
  /** Override the evaluation budget, for the P9 criteria. */
  budget?: { maxFacts: number; maxIterations: number; maxTimeMicro: number };
}

export interface VerifyOutcome {
  allowed: boolean;
  /** Failed checks, ideally naming block and rule (spec P8). */
  failed?: string[];
  /** True when the failure was cryptographic rather than logical. */
  signatureError?: boolean;
  /** True when the evaluation budget was exhausted (spec P9). */
  budgetExceeded?: boolean;
}

export interface MintInit {
  mesh: string;
  subject: string;
  /** The transport key the token is bound to (ADR-0009). */
  bound: string;
  roles: string[];
  expiresAt: Date;
  /** Absent ⇒ unrestricted, which is an explicit state (ADR-0020). */
  audience?: string[];
  /** Present ⇒ delegation permitted, scoped to this device key (ADR-0010). */
  delegationKey?: unknown;
  extraChecks?: string[];
}

export interface TokenCapability {
  /** A fresh mesh (issuer) key pair. */
  newMeshKey(): Promise<unknown>;
  /** A fresh device key pair, for delegation scoping. */
  newDeviceKey(): Promise<unknown>;
  /** Public half, for verification. */
  publicOf(key: unknown): unknown;
  mint(init: MintInit, meshKey: unknown): Promise<string>;
  verify(
    token: string,
    meshPublic: unknown,
    ctx: VerifyContext,
    rules: PolicySource,
  ): Promise<VerifyOutcome>;
  /** Narrow a token by appending constraints, offline. */
  attenuate?(token: string, meshPublic: unknown, constraints: string[]): Promise<string>;
  /** Delegate to another key, signed by the holder's device key (ADR-0010 amd.). */
  delegate?(
    token: string,
    meshPublic: unknown,
    holderKey: unknown,
    to: string,
    restrict: string[],
  ): Promise<string>;
  /** The forgeable path: append a delegate claim with no holder signature. */
  forgeDelegation?(token: string, meshPublic: unknown, to: string): Promise<string>;
  /** Called once before any verification. See prototype 10 finding F2. */
  warmUp?(): void;
}

export interface PolicySource {
  rules: string[];
  policies: string[];
}

export interface PolicyCapability {
  /** Validate a rule set whole; MUST throw listing every problem (P5). */
  build(source: PolicySource): PolicySource;
}

export interface IntermediaryCapability {
  /** Strip hop-by-hop headers, consume the mesh token, supply the upstream one. */
  asIntermediary(
    req: Request,
    opts: { via: string; credentials?: Record<string, string> },
  ): Request;
}

/** An implementation under test. Every capability is optional; absent ⇒ `missing`. */
export interface Implementation {
  readonly name: string;
  readonly notes?: string;
  mounts?: MountsCapability;
  tokens?: TokenCapability;
  policy?: PolicyCapability;
  intermediary?: IntermediaryCapability;
}

/** One check: given an implementation, either return (pass) or throw. */
export type Check = (impl: Implementation) => void | Promise<void>;
