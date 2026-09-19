import type { FormStatus, TitleDraft, TitleFormView } from "@p5/todos/api";
import type { ActionControl } from "@p5/kernel";
import { createAction, newChannels, stableGroup } from "@p5/kit-model";
import { batch, signal } from "@p5/kit-signals";

export interface RenameModel {
  readonly view: TitleFormView;
  readonly control: {
    reportErrors(errors: Readonly<Record<string, string>>): void;
    readonly save: ActionControl;
    readonly cancel: ActionControl;
  };
  dispose(): void;
}

const NO_ERRORS: Readonly<Record<string, string>> = Object.freeze({});

/** The rename form: the view writes `title`; the controller reports errors. */
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
  const rename = createAction({ label: "Rename" });
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
      save: rename.view,
      cancel: cancel.view,
    }),
    control: Object.freeze({
      reportErrors: (next: Readonly<Record<string, string>>) => {
        if (!disposed) errors(Object.freeze({ ...next }));
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
