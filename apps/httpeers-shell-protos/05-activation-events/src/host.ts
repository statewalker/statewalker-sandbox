// DERIVED-FROM-NOTE: 16-Prototypes 4 and 5 API Reference.md §3
// DERIVED-FROM-NOTE: 15-Prototypes 4 and 5: Manifest Generation and Activation.md §3
//
// RECONSTRUCTION, NOT RECOVERED CODE. The archive
// `14-prototype-05-activation-events.tar.gz` fails to decompress and no copy
// survives. Every signature below is transcribed verbatim from note 16 §3;
// every behaviour is either quoted from note 16's "Activation contract",
// "Live declaration recovery" and "Loader contract" sections, or is a decision
// taken here because the note is silent. Decisions are marked `DECIDED HERE`
// and are listed in this rung's README.
//
// PROTOTYPE 5 — can a contribution render before its module is imported?
//
// The whole rung is one sentence from note 16 §3: `menu` and `palette` render
// "entirely from manifest data", `invoke` imports "on first call for that
// app". The manifest is the shell's only knowledge of an application until
// someone actually runs one of its commands.

import type { CommandDeclaration, Commands } from "@statewalker/shared-commands";
import type { Slots } from "@statewalker/shared-slots";

/** Note 16 §1 — shared verbatim with prototype 4's generated output. */
export interface ManifestCommand {
  readonly key: string;
  readonly policy: "async" | "required" | "silent" | "custom";
  readonly label?: string;
  readonly description?: string;
  readonly icon?: string;
  /** Exported symbol name. This field exists solely for live declaration
   * recovery — see `activate()` below and note 16, "Live declaration
   * recovery". */
  readonly export: string;
}

/** Note 16 §1. `when` is carried but not evaluated here — see README. */
export interface ManifestMenuItem {
  readonly location: string;
  readonly command: string;
  readonly group?: string;
  readonly order?: number;
  readonly when?: string;
}

/**
 * Note 16 §4: this differs from prototype 4's `Manifest` only by adding `id`
 * and `activation` and dropping `diagnostics`, so generated output feeds the
 * host with no adaptation.
 */
export interface AppManifest {
  readonly id: string;
  readonly module: string;
  readonly commands: ManifestCommand[];
  readonly menus: ManifestMenuItem[];
  readonly activation: ActivationEvent[];
}

/** Note 16 §3: `"onStartup" | "onCommand:{key}"`, open-ended by design. */
export type ActivationEvent = string;

/**
 * Note 16, "Loader contract": the loader receives a MODULE ID, not a path to
 * concatenate. Callers resolve it against an explicit map or route table —
 * Vite cannot statically analyse a computed dynamic import specifier, and a
 * real loader would be resolving against a route table anyway.
 */
export type Loader = (modulePath: string) => Promise<Record<string, unknown>>;

/** Note 16 §3. */
export interface RenderedMenuEntry {
  readonly command: string;
  readonly label?: string;
  readonly icon?: string;
  readonly group?: string;
  readonly order?: number;
}

/**
 * Handed to a module's default export after import, so the application can
 * register its handlers on the shell's bus.
 *
 * DECIDED HERE: note 16 says only that the default export "is invoked with
 * `{ listen }`". The shape of `listen` is not given; it is bound from the
 * `Commands` instance passed to `createActivationHost`, which is the only
 * `listen` in scope.
 */
export interface ActivationContext {
  readonly listen: Commands["listen"];
}

/** Note 16 §3, verbatim. */
export interface ActivationHost {
  register(manifest: AppManifest): void;
  menu(location: string): RenderedMenuEntry[];
  palette(): ManifestCommand[];
  invoke(commandKey: string, payload: unknown): Promise<unknown>;
  startup(): Promise<void>;
  isActivated(appId: string): boolean;
}

type AnyDeclaration = CommandDeclaration<unknown, unknown>;

interface Registration {
  readonly manifest: AppManifest;
  /** Live `CommandDeclaration`s recovered from the module by export name. */
  readonly declarations: Map<string, AnyDeclaration>;
  /** The memoised activation. Cleared on rejection — see `activate()`. */
  activation?: Promise<void>;
  activated: boolean;
  /** Registration order, used as the menu sort tiebreak. */
  readonly seq: number;
}

/**
 * A manifest carries commands as JSON; the bus dispatches live
 * `CommandDeclaration`s. The bridge is the `export` field, and the check that
 * what came back is actually a declaration is structural because the module is
 * foreign code.
 */
function isCommandDeclaration(value: unknown): value is AnyDeclaration {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Partial<AnyDeclaration>;
  return typeof v.key === "string" && typeof v.inputSchema === "object" && v.inputSchema !== null;
}

/**
 * Note 16 §3.
 *
 * `slots` is accepted and DELIBERATELY UNUSED: note 16 §5 records it as an
 * open thread — "`Slots` is accepted by `createActivationHost` but currently
 * unused; menu rendering reads manifests directly. Reconciling
 * manifest-declared and runtime-contributed menu items is undesigned." It is
 * kept in the signature because the signature is the specification.
 */
export function createActivationHost(opts: {
  slots: Slots;
  commands: Commands;
  loader: Loader;
}): ActivationHost {
  const { commands, loader } = opts;
  void opts.slots;

  const registrations = new Map<string, Registration>();
  /** commandKey -> appId. Which application owns (implements) a command. */
  const owners = new Map<string, string>();
  /** commandKey -> declaration metadata, for rendering a menu entry that
   * names a command belonging to another application. */
  const declared = new Map<string, ManifestCommand>();
  let seq = 0;

  const listen: Commands["listen"] = (decl, fn, listenOpts) =>
    commands.listen(decl, fn, listenOpts);

  /**
   * Note 16, "Activation contract".
   *
   * Memoised per application, so concurrent `invoke` calls share one import.
   * THE MEMO IS CLEARED ON REJECTION: a failed load leaves `isActivated ===
   * false` and the live-declaration map empty, and the next `invoke` retries.
   * Memoising a rejected promise would permanently disable an application
   * after one transient failure.
   */
  function activate(reg: Registration): Promise<void> {
    if (reg.activation) return reg.activation;

    const started = (async () => {
      // The ONLY import in this file. Everything above and beside it renders
      // from manifest data.
      const mod = await loader(reg.manifest.module);

      // Live declaration recovery (note 16): the manifest is plain JSON, but
      // the bus needs a live declaration to dispatch. The manifest carries the
      // symbol name, so the declaration is `mod[c.export]`, stored per
      // registration. This replaced a module-level registry — a global — which
      // leaked state across hosts and could not be cleared on failure.
      for (const c of reg.manifest.commands) {
        const live = mod[c.export];
        // DECIDED HERE: an export the module does not actually have is NOT an
        // activation failure. The app's other commands still work; invoking
        // this one throws. Note 16 §5 records that nothing verifies a manifest
        // still matches its source, so a stale entry is expected to be
        // survivable rather than fatal.
        if (isCommandDeclaration(live)) reg.declarations.set(c.key, live);
      }

      // Note 16: "After import, the module's default export, if callable, is
      // invoked with `{ listen }` so the application can register handlers."
      const def = (mod as { default?: unknown }).default;
      if (typeof def === "function") {
        // DECIDED HERE: the return value is awaited, so an application that
        // registers asynchronously is fully registered before the `invoke`
        // that activated it dispatches. Note 16 does not say.
        await (def as (ctx: ActivationContext) => unknown)({ listen });
      }

      reg.activated = true;
    })().catch((err: unknown) => {
      reg.activation = undefined;
      reg.declarations.clear();
      reg.activated = false;
      throw err;
    });

    reg.activation = started;
    return started;
  }

  return {
    /** Imports nothing (note 16 §3, "Which methods import"). */
    register(manifest: AppManifest): void {
      // DECIDED HERE: a colliding app id throws rather than replacing, in line
      // with the keyed-slot collision semantics of prototype 1.
      if (registrations.has(manifest.id)) {
        throw new Error(`already registered: ${manifest.id}`);
      }
      registrations.set(manifest.id, {
        manifest,
        declarations: new Map(),
        activated: false,
        seq: seq++,
      });
      for (const c of manifest.commands) {
        // DECIDED HERE: first declaration of a key wins. Note 16 is silent on
        // two applications declaring the same command key.
        if (!owners.has(c.key)) {
          owners.set(c.key, manifest.id);
          declared.set(c.key, c);
        }
      }
    },

    /**
     * Renders ENTIRELY FROM MANIFEST DATA — note 16 §3 marks this "no" in
     * bold, and it is the prototype's result. No loader call happens on this
     * path, at any depth.
     */
    menu(location: string): RenderedMenuEntry[] {
      const rows: { entry: RenderedMenuEntry; group?: string; order: number; seq: number }[] = [];
      let itemSeq = 0;
      for (const reg of [...registrations.values()].sort((a, b) => a.seq - b.seq)) {
        for (const item of reg.manifest.menus) {
          if (item.location !== location) continue;
          // Label and icon come from the COMMAND's declaration, which may
          // belong to a different application than the menu item — the
          // string-key indirection of note 03 §2.
          const cmd = declared.get(item.command);
          rows.push({
            entry: {
              command: item.command,
              ...(cmd?.label !== undefined ? { label: cmd.label } : {}),
              ...(cmd?.icon !== undefined ? { icon: cmd.icon } : {}),
              ...(item.group !== undefined ? { group: item.group } : {}),
              ...(item.order !== undefined ? { order: item.order } : {}),
            },
            group: item.group,
            order: item.order ?? 0,
            seq: itemSeq++,
          });
        }
      }
      // DECIDED HERE (from note 11 §3, prototype 1's `resolveMenu`): note 16
      // §3 gives `group` and `order` on the rendered entry but no ordering
      // rule, so prototype 1's is reused — `navigation` first, remaining
      // groups lexicographic, `order` ascending within a group, contribution
      // order as tiebreak. Ungrouped entries sort last.
      const rank = (g?: string) => (g === "navigation" ? 0 : g === undefined ? 2 : 1);
      rows.sort(
        (a, b) =>
          rank(a.group) - rank(b.group) ||
          (a.group ?? "").localeCompare(b.group ?? "") ||
          a.order - b.order ||
          a.seq - b.seq,
      );
      return rows.map((r) => r.entry);
    },

    /** Imports nothing (note 16 §3). */
    palette(): ManifestCommand[] {
      const out: ManifestCommand[] = [];
      for (const reg of [...registrations.values()].sort((a, b) => a.seq - b.seq)) {
        out.push(...reg.manifest.commands);
      }
      return out;
    },

    /**
     * The one method that imports, and only on first call for that app.
     *
     * DECIDED HERE: note 16 says `invoke` "throws `not activatable`". Since
     * the declared return type is `Promise<unknown>`, that is realised as a
     * REJECTION rather than a synchronous throw, so a caller never has to
     * guard both. The loader is still not called.
     */
    async invoke(commandKey: string, payload: unknown): Promise<unknown> {
      const appId = owners.get(commandKey);
      const reg = appId ? registrations.get(appId) : undefined;
      // DECIDED HERE: a key no manifest declares is a different failure from a
      // key that is declared but not activatable. Note 16 covers only the
      // second.
      if (!reg) throw new Error(`unknown command: ${commandKey}`);

      // Note 16, "Activation contract": `invoke` on a command with no matching
      // `onCommand:` event (and no `onStartup`) throws WITHOUT CALLING THE
      // LOADER.
      const activatable =
        reg.manifest.activation.includes(`onCommand:${commandKey}`) ||
        reg.manifest.activation.includes("onStartup");
      if (!activatable) throw new Error(`not activatable: ${commandKey}`);

      await activate(reg);

      const decl = reg.declarations.get(commandKey);
      if (!decl) {
        const c = reg.manifest.commands.find((x) => x.key === commandKey);
        throw new Error(
          `no live declaration for ${commandKey} (export "${c?.export}" of ${reg.manifest.module})`,
        );
      }
      return commands.call(decl, payload).promise;
    },

    /**
     * Imports, for apps declaring `onStartup` — and for no others. Nothing is
     * imported before this is called.
     *
     * DECIDED HERE: a failing eager app rejects `startup()`. Note 16 says
     * nothing about isolating startup failures.
     */
    async startup(): Promise<void> {
      const eager = [...registrations.values()]
        .sort((a, b) => a.seq - b.seq)
        .filter((r) => r.manifest.activation.includes("onStartup"));
      await Promise.all(eager.map((r) => activate(r)));
    },

    /** Imports nothing (note 16 §3). */
    isActivated(appId: string): boolean {
      return registrations.get(appId)?.activated ?? false;
    },
  };
}
