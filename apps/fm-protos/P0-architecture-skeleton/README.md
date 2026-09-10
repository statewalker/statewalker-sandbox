# P0-architecture-skeleton — rung record

_Recovered verbatim from the Drive session `2026-09-08.File-Manager/P0-architecture-skeleton/`._

---

<!-- source: 01-P0 rung record and code.md -->

# P0 — Architecture skeleton · rung record

_9 September 2026 · green: 17/17 · mutations killed: 5/5_

## Verdict

The skeleton stands. Every mechanism the rest of the ladder depends on exists
in its real shape, doing something trivial. Promotion grade: **Adopt** for the
layering, controllers and declarations; **Source** for the job engine (its walk
is replaced wholesale at P3).

## Stack as installed

| Package | Version | Note |
| --- | --- | --- |
| `@statewalker/webrun-files` | 0.7.0 | surface matches file 02 exactly |
| `@statewalker/webrun-files-mem` | 0.7.2 | |
| `@statewalker/shared-commands` | 0.2.1 | `Command.required` → `{ onNoHandlers: "reject", onAllObserveOnly: "reject" }` |
| `@statewalker/shared-baseclass` | 0.1.1 | `toJSON` drops `_`-prefixed fields, as designed |
| zod | 4.x | Standard Schema source for command declarations |

Vitest 5. Schemas are zod because `Command.<policy>(key).input(schema)` requires
a Standard Schema validator — worth noting, it is a hard dependency of the
declaration builder, not a choice.

## Acceptance criteria, as tested

1. Views exist only because a controller emitted `ui:show-panel`; removed when
   the command settles, asserted from **both** sides.
2. The view writes only into `input`; a controller's writes to the outer model
   do not wake it.
3. `files:copy` returns a `jobId` synchronously; a host listener at priority 0
   beats the core's at −1 (asserted by the file **not** being copied).
4. The live `JobModel` crosses as a command payload; `renderCount > 1` proves
   progress is observed as state, not pushed as events.
5. Removing the originating panel mid-copy changes nothing; the job finishes.
6. A copy makes the target panel re-list on its own.
7. `panels:navigate` to a removed panel rejects as `not-claimed` (not
   `no-handlers`) — the distinction the design leans on.
8. No panel model exposes `commands`, `api` or `controller`.

## Findings to carry forward

- **The array-mutation hazard is real and was initially untested.** Mutation M4
  (`entries = buffer` → `entries.length = 0; entries.push(...)`) survived the
  first pass. `push()` + `notify()` is invisible to an `onChange` watcher of
  `() => model.entries`. A test using the real `onChange` helper now kills it.
  Every level field holding an array or object needs this test at P8/P9.
- **View removal on settle is a microtask, not synchronous.** The P12 adapter
  contract must say so, or hosts will write racy teardown assertions.
- **`FileStats.size` is still optional and `kind` is a flat field** in 0.7.0,
  so P1 is unstarted upstream, exactly as the plan assumes.
- The job engine already needs `yieldControl()` between entries to make
  cancellation observable at all. That is not a P3 refinement — without it a
  small job finishes before a cancel can land.

## Mutations run

| # | Mutation | Killed by |
| --- | --- | --- |
| M1 | core `files:copy` handler at priority 0 instead of −1 | host-override test |
| M2 | `panelId` guard removed | panel-scoping test |
| M3 | controller subscribes to `model.onUpdate`, not `input.onUpdate` | self-wake test |
| M4 | `entries` mutated in place | (added) `onChange` test |
| M5 | job awaited before returning `jobId` | detached-job test |

## Code

### `src/core/declarations.ts`

```ts
import { z } from "zod";
import { Command } from "@statewalker/shared-commands";
import type { JobModel } from "./job-model.js";

/** A resolved location. Never panel identity — that is what lets jobs outlive panels. */
export const fileRef = z.object({
  storage: z.string(),
  path: z.string(),
  kind: z.enum(["file", "directory"]),
});
export type FileRef = z.infer<typeof fileRef>;

/** Uniform payload contract: always an array, even for one file. */
export const filesCopy = Command.required("files:copy")
  .input(z.object({ files: z.array(fileRef), target: z.object({ storage: z.string(), path: z.string() }) }))
  .output(z.object({ jobId: z.string() }))
  .label("Copy")
  .build();

export const uiShowJob = Command.required("ui:show-job")
  .input(z.custom<JobModel>())
  .output(z.unknown())
  .build();
```

### `src/app/declarations.ts`

```ts
import { z } from "zod";
import { Command } from "@statewalker/shared-commands";
import type { PanelModel } from "./panel-model.js";

export { filesCopy, uiShowJob, fileRef, type FileRef } from "../core/declarations.js";

export const panelsNavigate = Command.required("panels:navigate")
  .input(z.object({ panelId: z.string(), path: z.string() }))
  .output(z.object({ path: z.string() }))
  .label("Navigate")
  .build();

export const uiShowPanel = Command.required("ui:show-panel")
  .input(z.custom<PanelModel>())
  .output(z.object({ closed: z.boolean() }))
  .build();
```

### `src/core/job-model.ts`

```ts
import { BaseClass } from "@statewalker/shared-baseclass";

export type JobStatus = "running" | "done" | "cancelled" | "failed";

/**
 * Progress is STATE, held in a model the view reflects — never a stream of
 * progress commands. The model is passed live as a command payload.
 */
export class JobModel extends BaseClass {
  status: JobStatus = "running";
  total = 0;
  completed = 0;
  error?: string;

  /** Underscore-prefixed: dropped by toJSON, invisible to the view. */
  private _abort = new AbortController();
  private _resolveDone!: () => void;
  readonly done: Promise<void>;

  constructor(readonly id: string) {
    super();
    this.done = new Promise<void>((resolve) => { this._resolveDone = resolve; });
  }

  get signal(): AbortSignal { return this._abort.signal; }
  cancel(): void { this._abort.abort(); }

  settle(status: JobStatus, error?: string): void {
    this.status = status;
    this.error = error;
    this.notify();
    this._resolveDone();
  }
}
```

### `src/core/job-engine.ts` — P0 fake, replaced at P3

```ts
import type { FilesApi } from "@statewalker/webrun-files";
import type { FileRef } from "./declarations.js";
import { JobModel } from "./job-model.js";

/** Releases the event loop and offers a cancellation point. Real batching is P3. */
const yieldControl = () => new Promise<void>((r) => setTimeout(r, 0));

export interface CopySpec {
  files: FileRef[];
  target: { storage: string; path: string };
  resolve(storage: string): FilesApi;
  onEntryDone?(ref: FileRef, targetPath: string): void;
}

let seq = 0;

export function startCopyJob(spec: CopySpec): JobModel {
  const job = new JobModel(`job-${++seq}`);
  job.total = spec.files.length;

  void (async () => {
    try {
      const target = spec.resolve(spec.target.storage);
      for (const ref of spec.files) {
        await yieldControl();
        if (job.signal.aborted) return job.settle("cancelled");
        const source = spec.resolve(ref.storage);
        const name = ref.path.split("/").pop() as string;
        const targetPath = `${spec.target.path}/${name}`;
        await target.write(targetPath, source.read(ref.path));
        job.completed++;
        job.notify();
        spec.onEntryDone?.(ref, targetPath);
      }
      job.settle("done");
    } catch (err) {
      job.settle("failed", String(err));
    }
  })();

  return job;
}
```

### `src/app/panel-model.ts`

```ts
import { BaseClass } from "@statewalker/shared-baseclass";
import type { FileInfo } from "@statewalker/webrun-files";

/**
 * View-owned input. The view writes ONLY here. Because it has its own notify
 * channel, a controller subscribed to `input.onUpdate` cannot be woken by its
 * own writes to the outer model.
 */
export class PanelInputModel extends BaseClass {
  requestedPath = "";
  navigateCount = 0;
}

/** Controller-owned stable data. No bus, no FilesApi, no controller reference. */
export class PanelModel extends BaseClass {
  path: string;
  entries: FileInfo[] = [];
  stale = false;
  error?: string;
  readonly input = new PanelInputModel();

  constructor(
    readonly id: string,
    readonly slot: string,
    readonly storage: string,
    path: string,
  ) {
    super();
    this.path = path;
  }
}
```

### `src/app/panel-controller.ts`

```ts
import type { Commands } from "@statewalker/shared-commands";
import type { FilesApi } from "@statewalker/webrun-files";
import { panelsNavigate, uiShowPanel } from "./declarations.js";
import type { PanelModel } from "./panel-model.js";

export class PanelController {
  private readonly _disposers: (() => void)[] = [];
  private _handledNavigate = 0;
  private _pending: Promise<void> = Promise.resolve();

  constructor(
    readonly model: PanelModel,
    private readonly _api: FilesApi,
    private readonly _commands: Commands,
    private readonly _onReaction: () => void,
  ) {}

  async activate(): Promise<void> {
    // Reacting to `input` only — never to the outer model this controller writes.
    this._disposers.push(this.model.input.onUpdate(() => this._reconcile()));
    this._disposers.push(
      this._commands.listen(panelsNavigate, (cmd) => {
        // The panelId guard is the FIRST statement: a listener that throws
        // before checking would kill a command meant for another panel.
        if (cmd.payload.panelId !== this.model.id) return;
        return this.navigate(cmd.payload.path).then(() => ({ path: this.model.path }));
      }),
    );
    // Controllers order views into existence; they never touch the DOM.
    const view = this._commands.call(uiShowPanel, this.model);
    this._disposers.push(() => view.resolve({ closed: true }));
    await this.refresh();
  }

  /** Idempotent reconciliation: desired state computed from current state. */
  private _reconcile(): void {
    this._onReaction();
    if (this.model.input.navigateCount > this._handledNavigate) {
      this._handledNavigate = this.model.input.navigateCount;
      this._track(this.navigate(this.model.input.requestedPath));
    }
  }

  async navigate(path: string): Promise<void> {
    this.model.path = path;
    await this.refresh();
  }

  async refresh(): Promise<void> {
    const buffer = [];
    for await (const entry of this._api.list(this.model.path)) buffer.push(entry);
    this.model.entries = buffer; // replaced, never mutated in place
    this.model.notify();
  }

  /** Invalidation by path prefix — the ten lines that fan out over panels. */
  invalidate(storage: string, path: string): void {
    if (storage !== this.model.storage) return;
    if (!path.startsWith(this.model.path)) return;
    this._track(this.refresh());
  }

  private _track(p: Promise<void>): void {
    this._pending = this._pending.then(() => p).catch(() => undefined);
  }

  settled(): Promise<void> { return this._pending; }

  dispose(): void {
    for (const off of this._disposers) off();
    this._disposers.length = 0;
  }
}
```

### `src/app/jobs-controller.ts`

```ts
import type { Commands } from "@statewalker/shared-commands";
import type { FilesApi } from "@statewalker/webrun-files";
import { startCopyJob } from "../core/job-engine.js";
import type { JobModel } from "../core/job-model.js";
import { filesCopy, uiShowJob } from "./declarations.js";

export class JobsController {
  private readonly _jobs = new Map<string, JobModel>();
  private readonly _disposers: (() => void)[] = [];
  private _lastJobId?: string;

  constructor(
    private readonly _commands: Commands,
    private readonly _resolve: (storage: string) => FilesApi,
    private readonly _onChange: (storage: string, path: string) => void,
  ) {}

  activate(): void {
    // The core registers its own handler at NEGATIVE priority: a host
    // overrides it simply by listening at priority 0.
    this._disposers.push(
      this._commands.listen(
        filesCopy,
        (cmd) => {
          const job = startCopyJob({
            files: cmd.payload.files,
            target: cmd.payload.target,
            resolve: this._resolve,
            onEntryDone: (_ref, targetPath) =>
              this._onChange(cmd.payload.target.storage, targetPath),
          });
          this._jobs.set(job.id, job);
          this._lastJobId = job.id;
          // The live progress model crosses the boundary as a command payload.
          this._commands.call(uiShowJob, job);
          return Promise.resolve({ jobId: job.id });
        },
        { priority: -1 },
      ),
    );
  }

  get(id: string): JobModel {
    const job = this._jobs.get(id);
    if (!job) throw new Error(`Unknown job: ${id}`);
    return job;
  }

  lastJobId(): string | undefined { return this._lastJobId; }

  dispose(): void { for (const off of this._disposers) off(); }
}
```

### `src/app/bootstrap.ts`

```ts
import type { Commands } from "@statewalker/shared-commands";
import type { FilesApi } from "@statewalker/webrun-files";
import { JobsController } from "./jobs-controller.js";
import { PanelController } from "./panel-controller.js";
import { PanelModel } from "./panel-model.js";
import type { JobModel } from "../core/job-model.js";

export interface PanelSpec { id: string; slot: string; storage: string; path: string; }

export interface BootstrapOptions {
  commands: Commands;
  storages: Record<string, FilesApi>;
  panels: PanelSpec[];
}

export interface App {
  panels: { get(id: string): PanelModel; remove(id: string): Promise<void> };
  jobs: { get(id: string): JobModel; lastJobId(): string | undefined };
  settled(): Promise<void>;
  debug: { panelReactions: number };
}

/**
 * Bootstrap order is fixed and is what makes `Command.required` correct
 * everywhere: the caller registers view handlers BEFORE calling this, so a
 * missing handler is unambiguously a wiring bug rather than a startup race.
 */
export async function bootstrap(options: BootstrapOptions): Promise<App> {
  const { commands, storages } = options;
  const resolve = (storage: string): FilesApi => {
    const api = storages[storage];
    if (!api) throw new Error(`Unknown storage: ${storage}`);
    return api;
  };

  const controllers = new Map<string, PanelController>();
  const debug = { panelReactions: 0 };

  const jobs = new JobsController(commands, resolve, (storage, path) => {
    for (const controller of controllers.values()) controller.invalidate(storage, path);
  });
  jobs.activate();

  for (const spec of options.panels) {
    const model = new PanelModel(spec.id, spec.slot, spec.storage, spec.path);
    const controller = new PanelController(model, resolve(spec.storage), commands, () => {
      debug.panelReactions++;
    });
    controllers.set(spec.id, controller);
    await controller.activate();
  }

  const require = (id: string): PanelController => {
    const c = controllers.get(id);
    if (!c) throw new Error(`Unknown panel: ${id}`);
    return c;
  };

  return {
    panels: {
      get: (id) => require(id).model,
      async remove(id) {
        const controller = require(id);
        controllers.delete(id);
        controller.dispose(); // settles ui:show-panel → the view is removed
        await controller.settled();
      },
    },
    jobs: { get: (id) => jobs.get(id), lastJobId: () => jobs.lastJobId() },
    async settled() {
      for (const c of controllers.values()) await c.settled();
      await new Promise((r) => setTimeout(r, 0));
      for (const c of controllers.values()) await c.settled();
    },
    debug,
  };
}
```

The acceptance suite (`test/p0-architecture.test.ts`, 17 cases) and the fake
view layer (`test/support/fake-view-layer.ts`) are the specification of this
rung; both are archived with the working tree.

