import type { MountConfig, MountStatus } from "./mount-types";

/** The shell areas a stored layout keeps widgets in. */
export type RestoreArea = "main" | "bottom" | "left" | "right";

const AREAS: Record<string, RestoreArea> = {
  mainPanel: "main",
  bottomPanel: "bottom",
  leftPanel: "left",
  rightPanel: "right",
};

/** What a widget description is matched by: its factory id and options. */
export function descriptionKey(constructionOptions: {
  factoryId: string;
  options?: unknown;
}): string {
  return JSON.stringify([constructionOptions.factoryId, constructionOptions.options ?? null]);
}

/**
 * Where each widget description of a stored shell layout (the parsed JSON,
 * before Theia inflates it) sits, by `descriptionKey`. Nested widget state is
 * a string there, so only the shell's own widgets are found.
 */
export function layoutAreas(layout: unknown): Map<string, RestoreArea> {
  const areas = new Map<string, RestoreArea>();
  for (const [desc, area] of layoutDescriptions(layout)) {
    areas.set(descriptionKey(desc.constructionOptions), area);
  }
  return areas;
}

/**
 * The mounts the shell's widgets in a stored layout live on: the ones
 * restoring that layout needs. Generic, so that any kind of widget counts: a
 * `file:` URI as a top-level value of a widget's options (an editor's `uri`,
 * a files panel's `folder`) or of its stored state (a files panel's `folder`)
 * names the mount (its first path segment). Deeper values are not looked at —
 * an explorer's expanded folders, say, do not make start-up wait.
 */
export function layoutMountKeys(layout: unknown): Set<string> {
  const keys = new Set<string>();
  for (const [desc] of layoutDescriptions(layout)) {
    for (const value of [
      ...topLevelValues(desc.constructionOptions.options),
      ...stateValues(desc),
    ]) {
      const key = fileMountKey(value);
      if (key !== undefined) keys.add(key);
    }
  }
  return keys;
}

function topLevelValues(value: unknown): unknown[] {
  return typeof value === "object" && value !== null ? Object.values(value) : [];
}

function stateValues(desc: StoredDescription): unknown[] {
  const state = desc.innerWidgetState;
  if (typeof state !== "string") return topLevelValues(state);
  try {
    return topLevelValues(JSON.parse(state));
  } catch {
    return [];
  }
}

type ConstructionOptions = { factoryId: string; options?: unknown };
type StoredDescription = { constructionOptions: ConstructionOptions; innerWidgetState?: unknown };

function layoutDescriptions(layout: unknown): [StoredDescription, RestoreArea][] {
  const found: [StoredDescription, RestoreArea][] = [];
  const visit = (value: unknown, area: RestoreArea) => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item, area);
      return;
    }
    if (typeof value !== "object" || value === null) return;
    const options = (value as { constructionOptions?: unknown }).constructionOptions;
    if (isConstructionOptions(options)) {
      found.push([value as StoredDescription, area]);
      return;
    }
    for (const child of Object.values(value)) visit(child, area);
  };
  if (typeof layout === "object" && layout !== null) {
    for (const [name, area] of Object.entries(AREAS)) {
      visit((layout as Record<string, unknown>)[name], area);
    }
  }
  return found;
}

/** A widget waiting for its mount to reopen, as kept across reloads. */
export interface PendingReopen {
  readonly description: { constructionOptions: ConstructionOptions; innerWidgetState?: unknown };
  readonly area: RestoreArea;
}

/**
 * The stored pending reopens (what `StorageService` gave back, possibly
 * nothing, or something malformed): the well-formed entries only.
 */
export function storedPending(stored: unknown): PendingReopen[] {
  if (!Array.isArray(stored)) return [];
  return stored.filter(
    (entry): entry is PendingReopen =>
      typeof entry === "object" &&
      entry !== null &&
      isConstructionOptions(entry.description?.constructionOptions) &&
      Object.values(AREAS).includes(entry.area),
  );
}

/**
 * The stored pending reopens still worth keeping at start-up: those on a
 * configured mount that is in the workspace. One on a mount removed, or taken
 * out of the workspace (`mounted: false`, remembered), is forgotten — it would
 * make every start wait for that mount, and resurface much later.
 */
export function livePending<T extends PendingReopen>(
  entries: readonly T[],
  configured: readonly MountConfig[],
): T[] {
  const inWorkspace = new Set(configured.filter((m) => m.mounted !== false).map((m) => m.key));
  return entries.filter((entry) => {
    const key = mountKeyOf(entry.description.constructionOptions.options);
    return key !== undefined && inWorkspace.has(key);
  });
}

/** Those whose mount has not settled as `failed` (after the start-up apply). */
export function unfailedPending<T extends PendingReopen>(
  entries: readonly T[],
  status: (key: string) => MountStatus | undefined,
): T[] {
  return entries.filter((entry) => {
    const key = mountKeyOf(entry.description.constructionOptions.options);
    return key === undefined || status(key)?.state !== "failed";
  });
}

/** `first`, then those of `then` not already in it (by `descriptionKey`). */
export function mergePending<T extends PendingReopen>(
  first: readonly T[],
  then: readonly T[],
): T[] {
  const seen = new Set(first.map((p) => descriptionKey(p.description.constructionOptions)));
  const merged = [...first];
  for (const entry of then) {
    const key = descriptionKey(entry.description.constructionOptions);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(entry);
  }
  return merged;
}

function isConstructionOptions(value: unknown): value is ConstructionOptions {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { factoryId?: unknown }).factoryId === "string"
  );
}

/**
 * The mount a file-backed widget lives on: the first path segment of the
 * `file:` URI in its options' `uri` (editors, viewers). Undefined otherwise.
 */
export function mountKeyOf(options: unknown): string | undefined {
  return fileMountKey((options as { uri?: unknown } | undefined)?.uri);
}

/** The mount a `file:` URI string is on: its first path segment. Undefined otherwise. */
function fileMountKey(uri: unknown): string | undefined {
  if (typeof uri !== "string") return undefined;
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return undefined;
  }
  if (url.protocol !== "file:") return undefined;
  const first = url.pathname.split("/").find(Boolean);
  return first === undefined ? undefined : decodeURIComponent(first);
}

/**
 * What startup still waits for before the layout is restored: a mount not
 * applied yet, or — for a mount locked behind the vault — the unlock prompt.
 * Nothing for a settled mount, nor for a local folder that only a click can
 * grant (`needs-access`).
 */
export function startupWait(status: MountStatus | undefined): "mount" | "vault" | undefined {
  if (!status) return "mount";
  return status.state === "locked" ? "vault" : undefined;
}

/** Whether `promise` settles (either way) within `ms`. */
export function within(promise: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  const settled = promise.then(
    () => true,
    () => true,
  );
  return Promise.race([settled, expired]).finally(() => clearTimeout(timer));
}
