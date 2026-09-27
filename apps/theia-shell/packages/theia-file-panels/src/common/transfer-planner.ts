import type URI from "@theia/core/lib/common/uri";

export interface TransferSource {
  uri: URI;
  isDirectory: boolean;
}
export type TransferOp = "copy" | "move" | "rename";
export type ClashPolicy = "overwrite" | "keepBoth" | "skip";
export interface TransferRequest {
  sources: TransferSource[];
  target: URI;
  /** Names already in the target folder. */
  existing: ReadonlySet<string>;
  op: TransferOp;
  /** The typed name; only for a single source. */
  name?: string;
  clash: ClashPolicy;
  /** " copy" for 1, " copy 2" for 2, …: localized by the caller. */
  copySuffix: (n: number) => string;
}
export interface TransferStep {
  op: "copy" | "move";
  from: URI;
  to: URI;
  overwrite: boolean;
}
export interface SkippedSource {
  uri: URI;
  reason: "clash" | "alreadyThere";
}
export interface TransferPlan {
  steps: TransferStep[];
  skipped: SkippedSource[];
}
export interface DropOptions {
  ops: TransferOp[];
  allInTarget: boolean;
  /** Names of sources from elsewhere that already exist in the target. */
  clashing: string[];
}
export type NameProblem = "empty" | "dots" | "slash";

const nameOf = (source: TransferSource) => source.uri.path.base;
const isIn = (source: TransferSource, folder: URI) => source.uri.parent.isEqual(folder);

/** A source that is the target or one of its ancestors: the drop is impossible. */
export function invalidDrop(sources: TransferSource[], target: URI): TransferSource | undefined {
  return sources.find((source) => source.uri.isEqualOrParent(target));
}

export function dropOptions(
  sources: TransferSource[],
  target: URI,
  existing: ReadonlySet<string>,
): DropOptions {
  const allInTarget = sources.length > 0 && sources.every((s) => isIn(s, target));
  const ops: TransferOp[] = allInTarget
    ? sources.length === 1
      ? ["copy", "rename"]
      : ["copy"]
    : ["copy", "move"];
  const clashing = sources.filter((s) => !isIn(s, target) && existing.has(nameOf(s))).map(nameOf);
  return { ops, allInTarget, clashing };
}

export function validateName(name: string): NameProblem | undefined {
  if (name.trim() === "") return "empty";
  if (name === "." || name === "..") return "dots";
  if (name.includes("/")) return "slash";
  return undefined;
}

/** `name` with the copy suffix before its extension (none for folders and dotfiles), counting on. */
export function freeName(
  name: string,
  isDirectory: boolean,
  taken: ReadonlySet<string>,
  copySuffix: (n: number) => string,
): string {
  const dot = isDirectory ? -1 : name.indexOf(".", 1);
  const stem = dot === -1 ? name : name.slice(0, dot);
  const ext = dot === -1 ? "" : name.slice(dot);
  for (let n = 1; ; n++) {
    const candidate = `${stem}${copySuffix(n)}${ext}`;
    if (!taken.has(candidate)) return candidate;
  }
}

export function planTransfer(request: TransferRequest): TransferPlan {
  const { sources, target, existing, op, clash, copySuffix } = request;
  const steps: TransferStep[] = [];
  const skipped: SkippedSource[] = [];
  /** Names in the target after the steps planned so far. */
  const taken = new Set(existing);
  /** Names this batch writes: never overwritten by a later source. */
  const written = new Set<string>();

  const add = (
    source: TransferSource,
    stepOp: "copy" | "move",
    name: string,
    overwrite: boolean,
  ) => {
    const to = target.resolve(name);
    if (to.isEqual(source.uri)) return;
    steps.push({ op: stepOp, from: source.uri, to, overwrite });
    taken.add(name);
    written.add(name);
  };

  if (op === "rename") {
    const [source] = sources;
    if (source && request.name !== undefined) {
      add(
        source,
        "move",
        request.name,
        request.name !== nameOf(source) && existing.has(request.name),
      );
    }
    return { steps, skipped };
  }

  if (sources.length === 1 && request.name !== undefined) {
    // A typed name that exists is replaced — the dialog says so. The one name that exists and
    // must not be replaced is the source itself, and `add` drops that step.
    const [source] = sources;
    add(source, op, request.name, existing.has(request.name));
    return { steps, skipped };
  }

  for (const source of sources) {
    const name = nameOf(source);
    if (isIn(source, target)) {
      if (op === "move") skipped.push({ uri: source.uri, reason: "alreadyThere" });
      else add(source, "copy", freeName(name, source.isDirectory, taken, copySuffix), false);
      continue;
    }
    if (!taken.has(name)) {
      add(source, op, name, false);
      continue;
    }
    const fromThisBatch = written.has(name);
    if (clash === "skip") skipped.push({ uri: source.uri, reason: "clash" });
    else if (clash === "overwrite" && !fromThisBatch) add(source, op, name, true);
    else add(source, op, freeName(name, source.isDirectory, taken, copySuffix), false);
  }
  return { steps, skipped };
}
