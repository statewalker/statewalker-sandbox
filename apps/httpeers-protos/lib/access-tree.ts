/**
 * `.access` as a walked tree.
 *
 * A resource path is resolved by walking root → leaf, applying each `.access`
 * policy found along the way, with **deny at the root by default** and later
 * (deeper) entries overriding earlier ones. The decision is *explainable*: the
 * walk records which node granted or denied, so a refusal can be traced rather
 * than guessed at.
 *
 * The grant is `{ mesh, roles }` rather than a peer id — a provider needs no
 * per-peer table, only a policy and the identity the handshake proved.
 *
 * `withAccessTree` throws at construction on a malformed policy and lists
 * every problem it found. A policy that denies everyone because of a typo is
 * indistinguishable at runtime from one that works, so the failure is made
 * loud and early instead.
 */

export interface Grant {
  /** Mesh whose members this grant is about. */
  mesh: string;
  /** Roles allowed. Empty means "any member of the mesh". */
  roles: string[];
}

export interface AccessNode {
  /** Path segment this policy sits on. "" is the root. */
  path: string;
  allow?: Grant[];
  /** Explicit deny wins over an inherited allow at the same depth. */
  deny?: Grant[];
}

export interface Caller {
  mesh: string;
  roles: string[];
}

export interface Decision {
  allowed: boolean;
  /** Which node settled it, and why. */
  decidedAt: string;
  reason: string;
  trace: string[];
}

const segments = (p: string): string[] => p.split("/").filter(Boolean);

function matches(g: Grant, caller: Caller): boolean {
  if (g.mesh !== caller.mesh) return false;
  return g.roles.length === 0 || g.roles.some((r) => caller.roles.includes(r));
}

export function withAccessTree(nodes: AccessNode[]) {
  // Fail fast, loudly, with every problem — not the first one.
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const n of nodes) {
    if (seen.has(n.path)) problems.push(`duplicate policy for path "${n.path}"`);
    seen.add(n.path);
    if (n.path !== "" && !n.path.startsWith("/")) {
      problems.push(`path "${n.path}" must start with "/" (or be "" for the root)`);
    }
    for (const g of [...(n.allow ?? []), ...(n.deny ?? [])]) {
      if (typeof g.mesh !== "string" || g.mesh.length === 0) {
        problems.push(`policy at "${n.path}" has a grant with no mesh`);
      }
      if (!Array.isArray(g.roles)) {
        problems.push(`policy at "${n.path}" has a grant whose roles is not an array`);
      }
    }
  }
  if (!seen.has("")) problems.push('no root policy ("") — the tree would have no deny-by-default');
  if (problems.length > 0) {
    throw new Error(`withAccessTree: refusing to start —\n  - ${problems.join("\n  - ")}`);
  }

  const byPath = new Map(nodes.map((n) => [n.path, n]));

  return function resolve(path: string, caller: Caller): Decision {
    const parts = segments(path);
    const trace: string[] = [];

    // Deny by default, at the root, before anything is consulted.
    let allowed = false;
    let decidedAt = "(root default)";
    let reason = "deny by default";

    for (let depth = 0; depth <= parts.length; depth += 1) {
      const nodePath = depth === 0 ? "" : `/${parts.slice(0, depth).join("/")}`;
      const node = byPath.get(nodePath);
      if (node === undefined) {
        trace.push(`${nodePath || "/"} — no policy, inherit`);
        continue;
      }
      const denied = (node.deny ?? []).find((g) => matches(g, caller));
      if (denied !== undefined) {
        allowed = false;
        decidedAt = nodePath || "/";
        reason = `explicit deny for mesh ${denied.mesh}${denied.roles.length ? ` roles ${denied.roles.join("|")}` : ""}`;
        trace.push(`${nodePath || "/"} — DENY`);
        continue;
      }
      const granted = (node.allow ?? []).find((g) => matches(g, caller));
      if (granted !== undefined) {
        allowed = true;
        decidedAt = nodePath || "/";
        reason =
          granted.roles.length === 0
            ? `any member of mesh ${granted.mesh}`
            : `role ${granted.roles.filter((r) => caller.roles.includes(r)).join("|")} in mesh ${granted.mesh}`;
        trace.push(`${nodePath || "/"} — allow`);
        continue;
      }
      trace.push(`${nodePath || "/"} — policy present, no matching grant`);
    }

    return { allowed, decidedAt, reason, trace };
  };
}
