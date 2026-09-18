import type { ContactDraft, ContactEditorView, ContactFormStatus } from "@b/contacts/api";
import { type CommitControl, createCommitAction } from "@kit/commit";
import { newChannels, shallowEqual, stableGroup } from "@kit/model";
import { batch, signal, untracked } from "@kit/signals";

export interface ContactEditorControl {
  /** Seeds / resets the whole form: base and draft, touched and errors clear. */
  reset(base: ContactDraft): void;
  reportErrors(errors: ContactFormStatus["errors"]): void;
  /** Save's records carry the draft at submit (mechanism C). */
  readonly save: CommitControl<ContactDraft>;
  readonly cancel: CommitControl<undefined>;
}

export interface ContactEditorModel {
  readonly view: ContactEditorView;
  readonly control: ContactEditorControl;
  dispose(): void;
}

const NO_ERRORS = Object.freeze({});
const freeze = (d: ContactDraft): ContactDraft =>
  Object.freeze({ name: d.name, email: d.email, phone: d.phone });

/** The contact form: the view writes fields; the controller resets the whole form and reports errors. */
export function createContactEditorModel(base: ContactDraft): ContactEditorModel {
  let disposed = false;
  const channels = newChannels(() => disposed);
  const alive = signal(true);
  const baseDraft = signal(freeze(base));
  const draft = signal(freeze(base));
  const touched = signal(false);
  const errors = signal<ContactFormStatus["errors"]>(NO_ERRORS);
  const status = stableGroup((): ContactFormStatus => {
    const b = baseDraft();
    const d = draft();
    const t = touched();
    const e = errors();
    return Object.freeze({ touched: t, dirty: !shallowEqual(b, d), errors: e });
  });
  const save = createCommitAction({
    label: "Save",
    capture: () => draft(),
    when: () => {
      const live = alive();
      const dirty = status().dirty;
      return live && dirty;
    },
  });
  const cancel = createCommitAction({
    label: "Cancel",
    capture: () => undefined,
    when: () => alive(),
  });
  const view: ContactEditorView = Object.freeze({
    getDraft: () => draft(),
    onDraftUpdate: channels.channel(draft),
    getStatus: () => status(),
    onStatusUpdate: channels.channel(status),
    editField: <K extends keyof ContactDraft>(field: K, value: ContactDraft[K]) => {
      if (disposed) return;
      const current = untracked(() => draft());
      batch(() => {
        if (current[field] !== value) draft(freeze({ ...current, [field]: value }));
        touched(true);
      });
    },
    save: save.view,
    cancel: cancel.view,
  });
  const control: ContactEditorControl = Object.freeze({
    reset: (next: ContactDraft) => {
      if (disposed) return;
      batch(() => {
        baseDraft(freeze(next));
        draft(freeze(next));
        touched(false);
        errors(NO_ERRORS);
      });
    },
    reportErrors: (next: ContactFormStatus["errors"]) => {
      if (!disposed) errors(Object.freeze({ ...next }));
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
