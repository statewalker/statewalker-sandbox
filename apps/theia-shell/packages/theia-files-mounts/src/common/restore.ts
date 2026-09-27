import type { MountStatus } from "./mount-types";

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
  const visit = (value: unknown, area: RestoreArea) => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item, area);
      return;
    }
    if (typeof value !== "object" || value === null) return;
    const options = (value as { constructionOptions?: unknown }).constructionOptions;
    if (isConstructionOptions(options)) {
      areas.set(descriptionKey(options), area);
      return;
    }
    for (const child of Object.values(value)) visit(child, area);
  };
  if (typeof layout === "object" && layout !== null) {
    for (const [name, area] of Object.entries(AREAS)) {
      visit((layout as Record<string, unknown>)[name], area);
    }
  }
  return areas;
}

function isConstructionOptions(value: unknown): value is { factoryId: string; options?: unknown } {
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
  const uri = (options as { uri?: unknown } | undefined)?.uri;
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
