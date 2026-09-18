import type { ContactDraft, ContactEditorView, ContactFormStatus } from "@b/contacts/api";
import type { ActionControl, ActionState, ActionView, Listener, Unsubscribe } from "@kernel";
import { createAction, newChannels, shallowEqual, stableGroup } from "@kit/model";
import { batch, signal, untracked } from "@kit/signals";

/** The form's commit: the draft frozen at submit, numbered. */
export interface Commit {
  readonly seq: number;
  readonly draft: ContactDraft;
}

export interface ContactEditorControl {
  /** Seeds / resets the whole form: base and draft, touched and errors clear. */
  reset(base: ContactDraft): void;
  reportErrors(errors: ContactFormStatus["errors"]): void;
  /** The last commit (mechanism B). Writer: the view, through `save.submit()`. */
  getCommit(): Commit | undefined;
  onCommitUpdate(listener: Listener): Unsubscribe;
  /** The controller has handled the commit `seq`. Writer: the controller. */
  settle(seq: number): void;
  /** Describes Save. Its `running` is the form's: a commit is not settled. */
  readonly save: ActionControl;
  readonly cancel: ActionControl;
}

export interface ContactEditorModel {
  readonly view: ContactEditorView;
  readonly control: ContactEditorControl;
  dispose(): void;
}

const NO_ERRORS = Object.freeze({});
const freeze = (d: ContactDraft): ContactDraft =>
  Object.freeze({ name: d.name, email: d.email, phone: d.phone });

/**
 * The contact form, mechanism B: `save.submit()` is the form's `commit()` — it freezes the draft
 * at that instant into `commit`, and Save shows `running` until the controller settles it.
 */
export function createContactEditorModel(base: ContactDraft): ContactEditorModel {
  let disposed = false;
  const channels = newChannels(() => disposed);
  const alive = signal(true);
  const baseDraft = signal(freeze(base));
  const draft = signal(freeze(base));
  const touched = signal(false);
  const errors = signal<ContactFormStatus["errors"]>(NO_ERRORS);
  const commit = signal<Commit | undefined>(undefined);
  const settled = signal(0);
  const status = stableGroup((): ContactFormStatus => {
    const b = baseDraft();
    const d = draft();
    const t = touched();
    const e = errors();
    return Object.freeze({ touched: t, dirty: !shallowEqual(b, d), errors: e });
  });
  const pending = () => {
    const c = commit();
    const s = settled();
    return c !== undefined && c.seq > s;
  };
  const save = createAction({
    label: "Save",
    when: () => {
      const live = alive();
      const dirty = status().dirty;
      return live && dirty;
    },
  });
  const saveState = stableGroup((): ActionState => {
    const s = save.view.getState();
    const p = pending();
    return p ? Object.freeze({ ...s, running: true }) : s;
  });
  const saveView: ActionView = Object.freeze({
    getState: () => saveState(),
    onStateUpdate: channels.channel(saveState),
    submit: () => {
      const s = untracked(() => saveState());
      if (disposed || !s.enabled || s.running) return;
      const seq = (untracked(() => commit())?.seq ?? 0) + 1;
      commit(Object.freeze({ seq, draft: untracked(() => draft()) }));
    },
  });
  const cancel = createAction({ label: "Cancel", when: () => alive() });
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
    save: saveView,
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
    getCommit: () => commit(),
    onCommitUpdate: channels.channel(commit),
    settle: (seq: number) => {
      if (!disposed && seq > untracked(() => settled())) settled(seq);
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
