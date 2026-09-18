import type { ContactDraft } from "@b/contacts/api";
import { drainCommits, on } from "@kit/commit";
import { newUpdateLoop } from "@kit/loop";
import { onSubmits } from "@kit/model";
import { describe, expect, it } from "vitest";
import { createContactEditorModel as formA } from "../../src/bundles/contacts.edit/a/editor.model.js";
import { createContactEditorModel as formB } from "../../src/bundles/contacts.edit/b/editor.model.js";
import { createContactEditorModel as formC } from "../../src/bundles/contacts.edit/c/editor.model.js";

/**
 * P3 acceptance 3: a deliberately wrong usage per mechanism — does a test or a type catch it?
 * Each mutant is a minimal Save controller over the REAL form model of its mechanism. Every mutant
 * compiles (tsc runs over this file): the TYPES catch none of the "re-read the draft" mutants. What
 * catches them is the race check each case runs (the same shape as races.test.ts). The expectations
 * below pin what the mutant does WRONG, so a mutant that stops being wrong fails this file.
 */
const base: ContactDraft = { name: "Ada", email: "a@x.org", phone: "1" };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function fakeApi() {
  const saved: ContactDraft[] = [];
  return {
    saved,
    async update(d: ContactDraft) {
      await wait(10);
      saved.push({ ...d });
    },
  };
}
const loopOf = (pass: () => Promise<void>) =>
  newUpdateLoop(pass, { isActive: () => true, onError: (e) => console.error(e) });

describe("A · controller snapshot — mutants", () => {
  it("re-reading the draft in the pass commits what was typed after the submit (race test catches)", async () => {
    const m = formA(base);
    const api = fakeApi();
    let owed = false;
    const loop = loopOf(async () => {
      if (!owed) return;
      owed = false;
      await api.update(m.view.getDraft()); // WRONG: read in the pass, not in the listener
    });
    onSubmits(m.control.save, () => {
      owed = true;
      loop.kick();
    });
    m.view.editField("name", "committed");
    m.view.save.submit();
    m.view.editField("name", "typed after");
    await loop.idle();
    expect(api.saved[0].name).toBe("typed after");
  });

  it("`=` instead of `??=`: two submits in one tick commit the SECOND state (race test catches)", async () => {
    const m = formA(base);
    const api = fakeApi();
    let commit: ContactDraft | undefined;
    const loop = loopOf(async () => {
      const c = commit;
      commit = undefined;
      if (c) await api.update(c);
    });
    onSubmits(m.control.save, () => {
      commit = m.view.getDraft(); // WRONG: the second submit overwrites the first
      loop.kick();
    });
    m.view.editField("name", "first");
    m.view.save.submit();
    m.view.editField("name", "second");
    m.view.save.submit();
    await loop.idle();
    expect(api.saved.map((d) => d.name)).toEqual(["second"]);
  });

  it("forgetting `running: true`: a submit while running is accepted, a second save goes out (race test catches)", async () => {
    const m = formA(base);
    const api = fakeApi();
    const commits: ContactDraft[] = [];
    const loop = loopOf(async () => {
      for (let c = commits.shift(); c; c = commits.shift()) await api.update(c); // WRONG: no running
    });
    onSubmits(m.control.save, () => {
      commits.push(m.view.getDraft());
      loop.kick();
    });
    m.view.editField("name", "one");
    m.view.save.submit();
    await wait(2);
    m.view.editField("name", "two");
    m.view.save.submit();
    await loop.idle();
    expect(api.saved).toHaveLength(2);
  });
});

describe("B · form commit — mutants", () => {
  it("taking the commit but re-reading the draft after an await commits a later state (race test catches)", async () => {
    const m = formB(base);
    const api = fakeApi();
    let handled = 0;
    const loop = loopOf(async () => {
      const c = m.control.getCommit();
      if (!c || c.seq <= handled) return;
      handled = c.seq;
      await wait(5); // step 1
      await api.update(m.view.getDraft()); // WRONG: c.draft is the commit
      m.control.settle(c.seq);
    });
    m.control.onCommitUpdate(() => loop.kick());
    m.view.editField("name", "committed");
    m.view.save.submit();
    m.view.editField("name", "typed during step 1");
    await loop.idle();
    expect(api.saved[0].name).toBe("typed during step 1");
  });

  it("forgetting `settle`: Save stays running and refuses forever (a 'save again after' test catches)", async () => {
    const m = formB(base);
    const api = fakeApi();
    let handled = 0;
    const loop = loopOf(async () => {
      const c = m.control.getCommit();
      if (!c || c.seq <= handled) return;
      handled = c.seq;
      await api.update(c.draft); // WRONG: no settle
    });
    m.control.onCommitUpdate(() => loop.kick());
    m.view.editField("name", "one");
    m.view.save.submit();
    await loop.idle();
    m.view.editField("name", "two");
    m.view.save.submit();
    await loop.idle();
    expect(m.view.save.getState().running).toBe(true);
    expect(api.saved.map((d) => d.name)).toEqual(["one"]);
  });
});

describe("C · commit records — mutants", () => {
  it("ignoring the record and reading the draft commits a later state (race test catches)", async () => {
    const m = formC(base);
    const api = fakeApi();
    const stop = drainCommits(
      { isActive: () => true, onError: (e) => console.error(e) },
      on(m.control.save, async () => {
        await wait(5);
        await api.update(m.view.getDraft()); // WRONG: the snapshot is the commit
      }),
    );
    m.view.editField("name", "committed");
    m.view.save.submit();
    m.view.editField("name", "typed after");
    await wait(40);
    expect(api.saved[0].name).toBe("typed after");
    stop();
  });

  it("the other A/B mutants cannot be written: no fold, no running write (type error), no settle to forget", async () => {
    const m = formC(base);
    // @ts-expect-error — running is derived from the records; the control cannot write it
    m.control.save.update({ running: false });
    const api = fakeApi();
    const stop = drainCommits(
      { isActive: () => true, onError: () => {} },
      on(m.control.save, (draft) => api.update(draft)),
    );
    m.view.editField("name", "first");
    m.view.save.submit();
    m.view.editField("name", "second");
    m.view.save.submit(); // refused in the same tick by the action itself
    await wait(30);
    expect(api.saved.map((d) => d.name)).toEqual(["first"]);
    expect(m.view.save.getState().running).toBe(false); // settled by the drain
    stop();
  });

  it("mutating the snapshot in a handler throws (deep-frozen record)", async () => {
    const m = formC(base);
    const errors: unknown[] = [];
    const stop = drainCommits(
      { isActive: () => true, onError: (e) => errors.push(e) },
      on(m.control.save, (draft) => {
        (draft as { name: string }).name = "patched"; // WRONG
      }),
    );
    m.view.editField("name", "x");
    m.view.save.submit();
    await wait(5);
    expect(errors[0]).toBeInstanceOf(TypeError);
    stop();
  });
});
