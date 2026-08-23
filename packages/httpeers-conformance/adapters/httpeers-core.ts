/**
 * Adapter over `@statewalker/httpeers.core`.
 *
 * Rewritten 2026-08-23, after the httpeers-stack line landed core's reconciliation
 * to ADR-0019: tokens are Biscuits, the access tree and vocabulary became Datalog
 * rules, and `audience` arrived. The previous version of this file declared no
 * `tokens` capability because core was JWT-shaped, and leaving it that way would
 * have reported core's ADR-0019 work as still missing — measuring the adapter's
 * staleness instead of the implementation.
 *
 * WHAT IS STILL NOT WIRED, and why:
 *
 * `attenuate` / `forgeDelegation` — core offers neither. That is CORRECT per
 * ADR-0010, which reserves delegation and defers enforcement to the reverse proxy,
 * so the criteria that need them report `missing` and the number is the truth.
 *
 * `intermediary` — no equivalent exists (D-11).
 *
 * Where core's API cannot express a test's INPUT — a token carrying an extra
 * constraint, or a delegation scope — the adapter raises `NotTestable` rather than
 * `NotImplemented`. Those are different claims: "this harness cannot build the
 * input through the public API" is not "the implementation lacks the behaviour".
 */
import {
  authorize,
  createMounts,
  generateMeshKey,
  mintToken,
  ruleSet,
  verifyToken,
  warmUpTokens,
  type MeshClaims,
  type RuleSet,
} from "@statewalker/httpeers.core";
import { peerIdFromPrivateKey } from "@libp2p/peer-id";
import type { Ed25519PrivateKey } from "@libp2p/interface";
import {
  NotTestable,
  type FetchHandler,
  type Implementation,
  type MountsTable,
  type PolicySource,
  type VerifyContext,
  type VerifyOutcome,
} from "../src/types.js";

const built = new Map<string, RuleSet>();
function compile(source: PolicySource): RuleSet {
  const key = JSON.stringify(source);
  let r = built.get(key);
  if (!r) {
    r = ruleSet({ rules: source.rules, policies: source.policies });
    built.set(key, r);
  }
  return r;
}

export const httpeersCoreImplementation: Implementation = {
  name: "@statewalker/httpeers.core",
  notes: "Reconciled to ADR-0019 by the httpeers-stack line, landed 2026-08-22.",

  mounts: {
    build(defs: Record<string, FetchHandler>): MountsTable {
      const m = createMounts();
      for (const [prefix, handler] of Object.entries(defs)) m.provide(prefix, handler);
      return { resolve: (path) => m.match(path) };
    },
  },

  policy: {
    build(source) {
      ruleSet({ rules: source.rules, policies: source.policies });
      return source;
    },
  },

  tokens: {
    warmUp: warmUpTokens,
    async newMeshKey() { return generateMeshKey(); },
    async newDeviceKey() { return generateMeshKey(); },
    /** Core verifies against the mesh peerId, which a private key derives. */
    publicOf(key) { return peerIdFromPrivateKey(key as Ed25519PrivateKey).toString(); },

    async mint(init, meshKey) {
      if (init.extraChecks?.length) {
        throw new NotTestable(
          "core's `mintToken` has no option for an extra token constraint, so this harness " +
            "cannot construct the input. Its verifier authorizes the token's own checks, so " +
            "the behaviour is likely present — it is unreachable through the public API.",
        );
      }
      if (init.delegationKey) {
        throw new NotTestable(
          "core mints no delegation scope. ADR-0010 reserves delegation and defers " +
            "enforcement to the reverse proxy, so this is the specified state, not a defect.",
        );
      }
      // Core carries ONE identity: `sub` is both the subject and the bound key.
      const ttlMs = init.expiresAt.getTime() - Date.now();
      return mintToken({
        privateKey: meshKey as Ed25519PrivateKey,
        sub: init.bound,
        roles: init.roles,
        ttlMs,
        ...(init.audience ? { audience: init.audience } : {}),
      });
    },

    async verify(token, meshPublic, ctx, rules): Promise<VerifyOutcome> {
      if (ctx.budget) {
        throw new NotTestable("core fixes its own evaluation limits; they are not injectable");
      }
      if ((ctx.revokedSubjects?.length ?? 0) + (ctx.revokedBindings?.length ?? 0) > 0) {
        throw new NotTestable(
          "core enforces revocation through a RevocationChecker wired into the binding " +
            "middleware, not through `verifyToken`; this harness passes a literal deny list",
        );
      }
      let claims: MeshClaims;
      try {
        claims = await verifyToken(token, {
          issuer: meshPublic as string,
          connectionPeer: ctx.connectionPeer,
          selfPeer: ctx.selfPeer,
          now: () => ctx.now.getTime(),
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return {
          allowed: false,
          signatureError: /signature|mesh|issuer/i.test(msg),
          failed: [msg],
        };
      }
      const d = authorize(compile(rules), {
        operation: ctx.operation,
        resource: ctx.resource,
        selfPeer: ctx.selfPeer,
        connectionPeer: ctx.connectionPeer,
        now: ctx.now.getTime(),
      }, claims);
      return { allowed: d.allowed, failed: d.failed.length ? d.failed : [d.reason] };
    },
  },
};
