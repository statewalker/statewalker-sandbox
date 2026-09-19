import type { ActionView, Listener, Unsubscribe } from "@p5/kernel";
import { type CommitControl, createCommitAction } from "@p5/kit-commit";
import { newChannels, shallowEqual, stableGroup } from "@p5/kit-model";
import { batch, signal, untracked } from "@p5/kit-signals";

/**
 * OPTIONAL kit (trait ledger: "share model factories through a kit, never through an API"): a
 * flat form of string-valued fields with Save and Cancel as commit actions. The view writes
 * fields; the controller resets the form whole and reports errors; Save's records carry the draft
 * at submit. Both editors and the rename dialog are instances of it.
 */
export type Draft = Readonly<Record<string, string>>;

export interface FormStatus<E extends string = string> {
  readonly touched: boolean;
  readonly dirty: boolean;
  readonly errors: Readonly<Partial<Record<E, string>>>;
}

export interface FormView<D extends Draft, E extends string = string> {
  getDraft(): D;
  onDraftUpdate(listener: Listener): Unsubscribe;
  getStatus(): FormStatus<E>;
  onStatusUpdate(listener: Listener): Unsubscribe;
  editField<K extends keyof D>(field: K, value: D[K]): void;
  readonly save: ActionView;
  readonly cancel: ActionView;
}

export interface FormControl<D extends Draft, E extends string = string> {
  /** Seeds / resets the whole form: base, draft (default: base); touched and errors clear. */
  reset(base: D, draft?: D): void;
  reportErrors(errors: Readonly<Partial<Record<E, string>>>): void;
  /** Save's records carry the draft at submit. */
  readonly save: CommitControl<D>;
  readonly cancel: CommitControl<undefined>;
}

export interface FormModel<D extends Draft, E extends string = string> {
  readonly view: FormView<D, E>;
  readonly control: FormControl<D, E>;
  dispose(): void;
}

export interface FormOptions<D extends Draft> {
  readonly saveLabel?: string;
  /** Save is enabled on an unchanged draft too (create mode). Default: only when dirty. */
  readonly allowClean?: boolean;
  /** The initial draft, when it differs from the base (a prefilled create form). */
  readonly draft?: D;
  /** Save's synchronous guard over the draft (e.g. a required field). */
  readonly valid?: (draft: D) => boolean;
}

const NO_ERRORS = Object.freeze({});
const frozen = <D extends Draft>(d: D): D => Object.freeze({ ...d });

export function createForm<D extends Draft, E extends string = string>(
  base: D,
  options: FormOptions<D> = {},
): FormModel<D, E> {
  let disposed = false;
  const channels = newChannels(() => disposed);
  const alive = signal(true);
  const baseDraft = signal(frozen(base));
  const draft = signal(frozen(options.draft ?? base));
  const touched = signal(false);
  const errors = signal<FormStatus<E>["errors"]>(NO_ERRORS);
  const valid = options.valid ?? (() => true);
  const status = stableGroup((): FormStatus<E> => {
    const b = baseDraft();
    const d = draft();
    const t = touched();
    const e = errors();
    return Object.freeze({ touched: t, dirty: !shallowEqual(b, d), errors: e });
  });
  const save = createCommitAction({
    label: options.saveLabel ?? "Save",
    capture: () => draft(),
    when: () => {
      const live = alive();
      const s = status();
      const ok = valid(draft());
      return live && ok && (options.allowClean === true || s.dirty);
    },
  });
  const cancel = createCommitAction({
    label: "Cancel",
    capture: () => undefined,
    when: () => alive(),
  });
  const view: FormView<D, E> = Object.freeze({
    getDraft: () => draft(),
    onDraftUpdate: channels.channel(draft),
    getStatus: () => status(),
    onStatusUpdate: channels.channel(status),
    editField: <K extends keyof D>(field: K, value: D[K]) => {
      if (disposed) return;
      const current = untracked(() => draft());
      batch(() => {
        if (current[field] !== value) draft(frozen({ ...current, [field]: value }));
        touched(true);
      });
    },
    save: save.view,
    cancel: cancel.view,
  });
  const control: FormControl<D, E> = Object.freeze({
    reset: (next: D, nextDraft: D = next) => {
      if (disposed) return;
      batch(() => {
        baseDraft(frozen(next));
        draft(frozen(nextDraft));
        touched(false);
        errors(NO_ERRORS);
      });
    },
    reportErrors: (next: FormStatus<E>["errors"]) => {
      if (!disposed)
        errors(Object.keys(next).length === 0 ? NO_ERRORS : Object.freeze({ ...next }));
    },
    save: save.control,
    cancel: cancel.control,
  });
  return Object.freeze({
    view,
    control,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      alive(false);
      save.dispose();
      cancel.dispose();
      channels.dispose();
    },
  });
}
