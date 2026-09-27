import type URI from "@theia/core/lib/common/uri";

export interface Crumb {
  uri: URI;
  /** The first crumb: a workspace root, or the path root when no root contains the folder. */
  isRoot: boolean;
}
export type CrumbItem = { kind: "crumb"; crumb: Crumb } | { kind: "more"; hidden: Crumb[] };
export type SiblingSource = { kind: "roots"; roots: URI[] } | { kind: "folder"; parent: URI };

/** The deepest workspace root that is `uri` or one of its ancestors. */
export function containingRoot(uri: URI, roots: URI[]): URI | undefined {
  return roots
    .filter((root) => root.isEqualOrParent(uri))
    .sort((a, b) => b.path.toString().length - a.path.toString().length)[0];
}

export function crumbsOf(current: URI, roots: URI[]): Crumb[] {
  const start = containingRoot(current, roots) ?? current.withPath("/");
  const chain: URI[] = [];
  for (let uri = current; ; uri = uri.parent) {
    chain.unshift(uri);
    if (uri.isEqual(start) || uri.path.isRoot) break;
  }
  return chain.map((uri, i) => ({ uri, isRoot: i === 0 }));
}

/** At most `max` items: the root, a "more" item with the hidden middle, and the last crumbs. */
export function collapseCrumbs(crumbs: Crumb[], max: number): CrumbItem[] {
  if (crumbs.length <= max) return crumbs.map((crumb) => ({ kind: "crumb", crumb }));
  const tail = crumbs.slice(crumbs.length - (max - 2));
  return [
    { kind: "crumb", crumb: crumbs[0] },
    { kind: "more", hidden: crumbs.slice(1, crumbs.length - tail.length) },
    ...tail.map((crumb): CrumbItem => ({ kind: "crumb", crumb })),
  ];
}

/** Where the ▾ of a crumb takes its list from; undefined when it has no siblings to show. */
export function siblingSource(crumb: Crumb, roots: URI[]): SiblingSource | undefined {
  if (crumb.isRoot) {
    return roots.some((root) => root.isEqual(crumb.uri)) ? { kind: "roots", roots } : undefined;
  }
  return { kind: "folder", parent: crumb.uri.parent };
}

/**
 * Where Go Up leads from `folder`: its parent — but nothing at a workspace root, since above the
 * roots lies no workspace folder (with mounts as roots, `file:///` is the hidden, read-only
 * composite), nor at the path root.
 */
export function parentWithin(folder: URI, roots: URI[]): URI | undefined {
  if (folder.path.isRoot || roots.some((root) => root.isEqual(folder))) return undefined;
  return folder.parent;
}

/**
 * The folders a vanished `uri` may fall back to, nearest first: its ancestors up to and including
 * the workspace root that contains it. None when roots exist but none contains it (a removed
 * mount): the caller then falls back to the first root, never to the space above the roots.
 */
export function fallbackAncestors(uri: URI, roots: URI[]): URI[] {
  const root = containingRoot(uri, roots);
  if (!root && roots.length > 0) return [];
  const ancestors: URI[] = [];
  for (let candidate = uri; !(root ? candidate.isEqual(root) : candidate.path.isRoot); ) {
    candidate = candidate.parent;
    ancestors.push(candidate);
  }
  return ancestors;
}
