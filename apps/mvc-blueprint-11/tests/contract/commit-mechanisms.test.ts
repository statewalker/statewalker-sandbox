import type { ActionControl, ActionState, ActionView } from "@kernel";
import {
  type CommitControl,
  type CommitRecord,
  createCommitAction,
  drainCommits,
  on,
} from "@kit/commit";
import { describe, expect, it } from "vitest";
import { createContactEditorModel as contactB } from "../../src/bundles/contacts.edit/b/editor.model.js";
import { createContactEditorModel as contactC } from "../../src/bundles/contacts.edit/c/editor.model.js";
import { createListModel as listB } from "../../src/bundles/todos.list/b/list.model.js";
import { createListModel as listC } from "../../src/bundles/todos.list/c/list.model.js";
import { createRenameModel as renameB } from "../../src/bundles/todos.rename/b/rename.model.js";
import { createRenameModel as renameC } from "../../src/bundles/todos.rename/c/rename.model.js";
import { modelContract } from "./model-contract.js";

/**
 * P3: do B (form commit) and C (commit records) keep the model contract (MODELS.md §4) and the
 * single-writer rule? The new groups — the form's commit (B), an action's records (C) — and the
 * derived Save state go through the same contract suite as every other group.
 */
const flush = () => new Promise((r) => setTimeout(r, 0));

// ── contract ─────────────────────────────────────────────────────────────────────────────────
modelContract("B · contact form commit group (view submits, controller settles)", {
  make() {
    const m = contactB({ name: "Ada", email: "a@x", phone: "1" });
    let n = 0;
    const commitAnew = () => {
      m.control.settle(m.control.getCommit()?.seq ?? 0);
      m.view.editField("name", `Ada ${++n}`);
      m.view.save.submit();
    };
    return {
      read: m.control.getCommit,
      subscribe: m.control.onCommitUpdate,
      change: commitAnew,
      changeEqual: () => m.view.save.submit(), // refused while pending, or disabled: no change
      changeOther: () => m.view.editField("phone", `${++n}`),
      dispose: m.dispose,
    };
  },
});

modelContract<ActionState>("B · Save state derived from the form's commit", {
  make() {
    const m = contactB({ name: "Ada", email: "a@x", phone: "1" });
    let n = 0;
    return {
      read: m.view.save.getState,
      subscribe: m.view.save.onStateUpdate,
      change: () => m.control.save.update({ label: `Save ${++n}` }),
      changeEqual: () => m.control.save.update({ label: m.view.save.getState().label }),
      changeOther: () => m.control.reportErrors({ form: `e${++n}` }),
      dispose: m.dispose,
    };
  },
});

modelContract("C · commit records group (view submits, controller settles)", {
  make() {
    let n = 0;
    const m = createCommitAction({ label: "Add", queue: true, capture: () => n });
    return {
      read: m.control.getRecords,
      subscribe: m.control.onRecordsUpdate,
      change: () => {
        n++;
        m.view.submit(); // one intention: one record appended
      },
      changeEqual: () => m.control.settle(0),
      changeOther: () => m.control.update({ label: `L${++n}` }),
      dispose: m.dispose,
    };
  },
});

modelContract<ActionState>("C · commit action state (running derived)", {
  make() {
    const m = createCommitAction({ label: "Save", capture: () => 1 });
    let n = 0;
    return {
      read: m.view.getState,
      subscribe: m.view.onStateUpdate,
      change: () => m.control.update({ label: `Save ${++n}` }),
      changeEqual: () => m.control.update({ label: m.view.getState().label }),
      dispose: m.dispose,
    };
  },
});

modelContract("C · contact editor draft", {
  make() {
    const m = contactC({ name: "Ada", email: "a@x", phone: "1" });
    let n = 0;
    return {
      read: m.view.getDraft,
      subscribe: m.view.onDraftUpdate,
      change: () => m.view.editField("name", `Ada ${++n}`),
      changeEqual: () => m.view.editField("name", m.view.getDraft().name),
      changeOther: () => m.control.reportErrors({ form: `e${++n}` }),
      dispose: m.dispose,
    };
  },
});

// ── single writer ────────────────────────────────────────────────────────────────────────────
type FieldWriter = "editField" | "select" | "setNewTitle" | "submit" | "dismiss";
type PresentationWriter = `publish${string}` | `report${string}` | "reset" | "update" | "settle";
type Clean<T> = [T] extends [never] ? true : false;
type NoFieldWriter<C> = Clean<Extract<keyof C, FieldWriter>>;
type NoPresentationWriter<V> = Clean<Extract<keyof V, PresentationWriter>>;

const typeLevel: [
  NoFieldWriter<CommitControl<unknown>>,
  NoFieldWriter<ReturnType<typeof contactB>["control"]>,
  NoFieldWriter<ReturnType<typeof renameB>["control"]>,
  NoFieldWriter<ReturnType<typeof listB>["control"]>,
  NoFieldWriter<ReturnType<typeof listB>["control"]["commits"]["add"]>,
  NoFieldWriter<ReturnType<typeof contactC>["control"]>,
  NoFieldWriter<ReturnType<typeof renameC>["control"]>,
  NoFieldWriter<ReturnType<typeof listC>["control"]>,
  NoPresentationWriter<ActionView>,
] = [true, true, true, true, true, true, true, true, true];

// C: `running` is derived — a controller cannot write it.
const commitControl = createCommitAction({ label: "x", capture: () => 0 }).control;
// @ts-expect-error — `running` is not part of a commit action's description
commitControl.update({ running: true });
// B: the form derives `running` too, but Save's inner ActionControl still accepts a write (unused).
const bSave: ActionControl = contactB({ name: "a", email: "b", phone: "c" }).control.save;
bSave.update({ running: false });

describe("single writer, B and C", () => {
  it("type-level checks compiled (see tsc)", () => {
    expect(typeLevel.every(Boolean)).toBe(true);
  });

  it("runtime: facets are frozen; view facets hold no settle/report/update, controls no submit/edit", () => {
    const models = [
      contactB({ name: "a", email: "b", phone: "c" }),
      contactC({ name: "a", email: "b", phone: "c" }),
      renameB("x"),
      renameC("x"),
      listB(),
      listC(),
    ];
    for (const m of models) {
      expect(Object.isFrozen(m.view)).toBe(true);
      expect(Object.isFrozen(m.control)).toBe(true);
      for (const k of Object.keys(m.view)) expect(k).not.toMatch(/^(publish|report|settle|update)/);
      for (const k of Object.keys(m.control))
        expect(k).not.toMatch(/^(editField|select|setNewTitle|submit)$/);
    }
  });
});

// ── the kit: records, refusal, order, settlement ─────────────────────────────────────────────
describe("C kit · createCommitAction / drainCommits", () => {
  it("captures at submit, deep-frozen: a later change or a mutation cannot reach the record", () => {
    const draft = { title: "a", tags: ["x"] };
    const m = createCommitAction({ label: "Save", capture: () => draft });
    m.view.submit();
    draft.title = "b";
    draft.tags.push("y");
    const [record] = m.control.getRecords();
    expect(record.snapshot).toEqual({ title: "a", tags: ["x"] });
    expect(() => {
      (record.snapshot as { title: string }).title = "c";
    }).toThrow(TypeError);
    expect(() => (record.snapshot.tags as string[]).push("z")).toThrow(TypeError);
  });

  it("refuse (default): running flips inside submit, so a second submit in the same tick is refused", () => {
    const m = createCommitAction({ label: "Save", capture: () => 1 });
    m.view.submit();
    expect(m.view.getState().running).toBe(true);
    m.view.submit();
    expect(m.control.getRecords()).toHaveLength(1);
    m.control.settle(m.control.getRecords()[0].seq);
    expect(m.view.getState().running).toBe(false);
  });

  it("queue: every submit is a record, each with its own snapshot", () => {
    let n = 0;
    const m = createCommitAction({ label: "Add", queue: true, capture: () => ++n });
    m.view.submit();
    m.view.submit();
    m.view.submit();
    expect(m.control.getRecords().map((r) => r.snapshot)).toEqual([1, 2, 3]);
  });

  it("disabled and disposed actions record nothing", () => {
    const m = createCommitAction({ label: "Save", enabled: false, capture: () => 1 });
    m.view.submit();
    m.control.update({ enabled: true });
    m.dispose();
    m.view.submit();
    expect(m.control.getRecords()).toHaveLength(0);
  });

  it("the drain handles records one at a time in commit order across actions, and settles each", async () => {
    const a = createCommitAction({ label: "A", queue: true, capture: () => "a" });
    const b = createCommitAction({ label: "B", capture: () => "b" });
    const seen: string[] = [];
    let release = () => {};
    const stop = drainCommits(
      { isActive: () => true, onError: () => {} },
      on(a.control, async (s, r: CommitRecord<string>) => {
        seen.push(`${s}${r.seq > 0 ? "" : "?"}`);
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }),
      on(b.control, (s) => {
        seen.push(s);
      }),
    );
    a.view.submit();
    b.view.submit();
    a.view.submit();
    await flush();
    expect(seen).toEqual(["a"]); // the first handler is still running
    expect(a.view.getState().running && b.view.getState().running).toBe(true);
    release();
    await flush();
    expect(seen).toEqual(["a", "b", "a"]);
    release();
    await flush();
    expect(a.view.getState().running || b.view.getState().running).toBe(false);
    stop();
  });

  it("a throwing handler is reported and its record still settles", async () => {
    const a = createCommitAction({ label: "A", capture: () => 1 });
    const errors: unknown[] = [];
    const stop = drainCommits(
      { isActive: () => true, onError: (e) => errors.push(e) },
      on(a.control, () => {
        throw new Error("boom");
      }),
    );
    a.view.submit();
    await flush();
    expect(errors).toHaveLength(1);
    expect(a.view.getState().running).toBe(false);
    stop();
  });

  it("a stopped drain handles nothing more; records left are not silently settled", async () => {
    const a = createCommitAction({ label: "A", queue: true, capture: () => 1 });
    let handled = 0;
    let release = () => {};
    const stop = drainCommits(
      { isActive: () => true, onError: () => {} },
      on(a.control, async () => {
        handled++;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }),
    );
    a.view.submit();
    a.view.submit();
    await flush();
    stop();
    release();
    await flush();
    expect(handled).toBe(1);
    expect(a.control.getRecords()).toHaveLength(1); // the second is still visible as pending
  });
});
