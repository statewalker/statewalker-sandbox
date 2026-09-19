import type { FormStatus, TitleDraft, TitleFormView } from "@b/todos/api";
import type { ActionControl } from "@kernel";
import { createAction, newChannels, stableGroup } from "@kit/model";
import { batch, signal } from "@kit/signals";

export interface EditorControl {
  /** Seeds / resets the whole form (one intention): base, draft (default: base), touched, errors. */
  reset(base: TitleDraft, draft?: TitleDraft): void;
  reportErrors(errors: Readonly<Record<string, string>>): void;
  readonly save: ActionControl;
  readonly cancel: ActionControl;
}

export interface EditorModel {
  readonly view: TitleFormView;
  readonly control: EditorControl;
  dispose(): void;
}

const NO_ERRORS: Readonly<Record<string, string>> = Object.freeze({});

/**
 * A one-field form: the view writes `title`; the controller seeds/resets it whole and reports
 * errors. Save's `enabled` is derived here, synchronously: a non-empty title, and — unless
 * `allowClean` (create mode) — a draft that differs from its base.
 */
export function createEditorModel(
  base: TitleDraft,
  options: { saveLabel?: string; allowClean?: boolean; draft?: TitleDraft } = {},
): EditorModel {
  let disposed = false;
  const channels = newChannels(() => disposed);
  const alive = signal(true);
  const baseTitle = signal(base.title);
  const title = signal((options.draft ?? base).title);
  const touched = signal(false);
  const errors = signal(NO_ERRORS);

  const draft = stableGroup((): TitleDraft => Object.freeze({ title: title() }));
  const status = stableGroup((): FormStatus => {
    const b = baseTitle();
    const t = title();
    const tc = touched();
    const e = errors();
    return Object.freeze({ touched: tc, dirty: t !== b, errors: e });
  });

  const save = createAction({
    label: options.saveLabel ?? "Save",
    when: () => {
      const live = alive();
      const s = status();
      const t = title();
      return live && t.trim() !== "" && (options.allowClean === true || s.dirty);
    },
  });
  const cancel = createAction({ label: "Cancel", when: () => alive() });

  const view: TitleFormView = Object.freeze({
    getDraft: () => draft(),
    onDraftUpdate: channels.channel(draft),
    getStatus: () => status(),
    onStatusUpdate: channels.channel(status),
    editField: <K extends keyof TitleDraft>(field: K, value: TitleDraft[K]) => {
      if (disposed || field !== "title") return;
      batch(() => {
        title(value);
        touched(true);
      });
    },
    save: save.view,
    cancel: cancel.view,
  });
  const control: EditorControl = Object.freeze({
    reset: (next: TitleDraft, nextDraft: TitleDraft = next) => {
      if (disposed) return;
      batch(() => {
        baseTitle(next.title);
        title(nextDraft.title);
        touched(false);
        errors(NO_ERRORS);
      });
    },
    reportErrors: (next: Readonly<Record<string, string>>) => {
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
