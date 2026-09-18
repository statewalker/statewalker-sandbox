import type { FormStatus, TitleDraft, TitleFormView } from "@b/todos/api";
import type { ActionControl, ActionState, ActionView, Listener, Unsubscribe } from "@kernel";
import { createAction, newChannels, stableGroup } from "@kit/model";
import { batch, signal, untracked } from "@kit/signals";

/** The form's commit: the title frozen at submit, numbered. */
export interface Commit {
  readonly seq: number;
  readonly title: string;
}

export interface RenameModel {
  readonly view: TitleFormView;
  readonly control: {
    reportErrors(errors: Readonly<Record<string, string>>): void;
    /** The last commit (mechanism B). Writer: the view, through `save.submit()`. */
    getCommit(): Commit | undefined;
    onCommitUpdate(listener: Listener): Unsubscribe;
    /** The controller has handled the commit `seq`. Writer: the controller. */
    settle(seq: number): void;
    readonly save: ActionControl;
    readonly cancel: ActionControl;
  };
  dispose(): void;
}

const NO_ERRORS: Readonly<Record<string, string>> = Object.freeze({});

/**
 * The rename form, mechanism B: the view writes `title`; `save.submit()` is the form's `commit()`
 * (the title frozen at that instant); Rename shows `running` until the controller settles it.
 */
export function createRenameModel(title: string): RenameModel {
  let disposed = false;
  const channels = newChannels(() => disposed);
  const draft = signal<TitleDraft>(Object.freeze({ title }));
  const touched = signal(false);
  const errors = signal(NO_ERRORS);
  const status = stableGroup((): FormStatus => {
    const d = draft();
    const t = touched();
    const e = errors();
    return Object.freeze({ touched: t, dirty: d.title !== title, errors: e });
  });
  const commit = signal<Commit | undefined>(undefined);
  const settled = signal(0);
  const rename = createAction({ label: "Rename" });
  const renameState = stableGroup((): ActionState => {
    const s = rename.view.getState();
    const c = commit();
    const done = settled();
    return c !== undefined && c.seq > done ? Object.freeze({ ...s, running: true }) : s;
  });
  const renameView: ActionView = Object.freeze({
    getState: () => renameState(),
    onStateUpdate: channels.channel(renameState),
    submit: () => {
      const s = untracked(() => renameState());
      if (disposed || !s.enabled || s.running) return;
      const seq = (untracked(() => commit())?.seq ?? 0) + 1;
      commit(Object.freeze({ seq, title: untracked(() => draft()).title }));
    },
  });
  const cancel = createAction({ label: "Cancel" });
  return Object.freeze({
    view: Object.freeze({
      getDraft: () => draft(),
      onDraftUpdate: channels.channel(draft),
      getStatus: () => status(),
      onStatusUpdate: channels.channel(status),
      editField: <K extends keyof TitleDraft>(field: K, value: TitleDraft[K]) => {
        if (disposed || field !== "title") return;
        batch(() => {
          draft(Object.freeze({ title: value }));
          touched(true);
        });
      },
      save: renameView,
      cancel: cancel.view,
    }),
    control: Object.freeze({
      reportErrors: (next: Readonly<Record<string, string>>) => {
        if (!disposed) errors(Object.freeze({ ...next }));
      },
      getCommit: () => commit(),
      onCommitUpdate: channels.channel(commit),
      settle: (seq: number) => {
        if (!disposed && seq > untracked(() => settled())) settled(seq);
      },
      save: rename.control,
      cancel: cancel.control,
    }),
    dispose: () => {
      if (disposed) return;
      disposed = true;
      rename.dispose();
      cancel.dispose();
      channels.dispose();
    },
  });
}
