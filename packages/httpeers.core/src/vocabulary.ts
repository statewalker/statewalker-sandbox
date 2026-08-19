/**
 * A-3: the role vocabulary.
 *
 * Until this file existed, role names like `member` and `admin` lived
 * nowhere but as string literals inside `.access` entries, invitations and
 * membership records. A typo on the policy side (`anyOf: ['admni']`)
 * silently denies everyone; a typo on the grant side (inviting with role
 * `admni`) silently grants nothing. Both look like working software with a
 * mysterious permissions bug — the worst kind, because the symptom points
 * away from the cause.
 *
 * The vocabulary is a single document, owned by the mesh, that:
 *  - declares which capabilities exist
 *  - declares which roles exist and what capabilities each confers
 *  - lets roles imply other roles, so `admin` need not restate `member`
 *
 * Policy (`access-tree.ts`) is then written against CAPABILITIES, not
 * roles. Roles describe people; capabilities are what code checks.
 * Renaming a role, or splitting one in two, then touches no `.access` entry
 * at all.
 *
 * Role names are plain (`member`, `admin`) — only capabilities are
 * namespaced (`std:` reserved for the mesh protocol itself, `app:` for
 * whatever this stack builds on top). Namespacing roles too would be
 * over-applying that argument: roles are local to one mesh's membership
 * model, not a thing other meshes or protocols ever need to address by
 * name the way a capability check does.
 *
 * VALIDATION FAILS FAST, NOT CLOSED. An unknown capability in a policy is a
 * construction-time error, not a runtime denial — see `withAccessTree` in
 * `access-tree.ts`. A policy that denies everyone because of a typo is
 * indistinguishable from a policy that is working, and that is a far worse
 * failure than refusing to start.
 */

export interface CapabilityDef {
  description?: string;
}

export interface RoleDef {
  /** Capabilities this role confers directly. */
  capabilities?: string[];
  /** Roles whose capabilities are also conferred. Resolved transitively. */
  implies?: string[];
  description?: string;
}

export interface Vocabulary {
  /** Bumped on every edit; carried in the heartbeat version vector (a later task). */
  version: number;
  capabilities: Record<string, CapabilityDef>;
  roles: Record<string, RoleDef>;
}

export class VocabularyError extends Error {
  constructor(public readonly problems: string[]) {
    super(`invalid vocabulary or policy:\n  - ${problems.join("\n  - ")}`);
    this.name = "VocabularyError";
  }
}

/**
 * Expand role names to the capability set they confer, following `implies`
 * transitively.
 *
 * An unknown role contributes nothing rather than throwing: a peer may
 * legitimately hold a role this peer's copy of the vocabulary has not heard
 * of yet. Version skew therefore degrades to FEWER permissions, never
 * more — which is what makes a rolling vocabulary update safe.
 */
export function expandRoles(vocab: Vocabulary, roles: string[]): Set<string> {
  const caps = new Set<string>();
  const seen = new Set<string>();

  const visit = (name: string): void => {
    if (seen.has(name)) return; // also breaks cycles
    seen.add(name);
    const def = vocab.roles[name];
    if (def == null) return;
    for (const c of def.capabilities ?? []) caps.add(c);
    for (const r of def.implies ?? []) visit(r);
  };

  for (const r of roles) visit(r);
  return caps;
}

/** Structural problems with the vocabulary itself. */
export function validateVocabulary(vocab: Vocabulary): string[] {
  const problems: string[] = [];

  for (const [name, def] of Object.entries(vocab.roles)) {
    for (const c of def.capabilities ?? []) {
      if (!(c in vocab.capabilities)) {
        problems.push(`role '${name}' confers undeclared capability '${c}'`);
      }
    }
    for (const r of def.implies ?? []) {
      if (!(r in vocab.roles)) {
        problems.push(`role '${name}' implies unknown role '${r}'`);
      }
    }
  }

  // Cycles are tolerated by expandRoles but almost always a mistake.
  for (const name of Object.keys(vocab.roles)) {
    const path: string[] = [];
    const walk = (n: string): boolean => {
      if (path.includes(n)) {
        problems.push(`role cycle: ${[...path, n].join(" -> ")}`);
        return true;
      }
      path.push(n);
      for (const r of vocab.roles[n]?.implies ?? []) if (walk(r)) return true;
      path.pop();
      return false;
    };
    walk(name);
  }

  return [...new Set(problems)];
}

/** Roles named in an invitation or a membership record must exist. */
export function validateRoles(vocab: Vocabulary, roles: string[], context: string): string[] {
  return roles.filter((r) => !(r in vocab.roles)).map((r) => `${context}: unknown role '${r}'`);
}

export function assertValid(problems: string[]): void {
  if (problems.length > 0) throw new VocabularyError(problems);
}

// ---------------------------------------------------------------------------
// The default mesh vocabulary
// ---------------------------------------------------------------------------

/**
 * `std:` names are reserved for the mesh protocol itself. Application
 * capabilities should use their own prefix (`app:`) so a future protocol
 * addition cannot collide with one.
 */
export const DEFAULT_VOCABULARY: Vocabulary = {
  version: 1,
  capabilities: {
    "std:mesh.read": { description: "read the member and presence view" },
    "std:mesh.admin": { description: "invite, remove and re-role members" },
    "std:presence.write": { description: "check in and publish addresses" },
    "std:test": { description: "reach the /test surface" },
  },
  roles: {
    member: {
      description: "an ordinary peer of the mesh",
      capabilities: ["std:mesh.read", "std:presence.write", "std:test"],
    },
    admin: {
      description: "may change who is in the mesh",
      implies: ["member"],
      capabilities: ["std:mesh.admin"],
    },
    hidden: {
      description: "a member omitted from the mesh view of non-admins",
      implies: ["member"],
    },
  },
};
