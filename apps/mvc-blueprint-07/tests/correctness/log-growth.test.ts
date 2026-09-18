import { describe, expect, it } from "vitest";
import { createIntentLog, setIntentLog } from "../../src/kernel/log.js";
import { start } from "../support/headless.js";
import {
  confirmDialog,
  contactAction,
  contactEditor,
  contactList,
  editor,
  list,
  openTodoEditor,
  toolbarAction,
} from "../support/todos.js";

/** Types a value one keystroke at a time, counting keystrokes (what "every keystroke an intent" would log). */
let keystrokes = 0;
const type = (write: (v: string) => void, value: string) => {
  for (let i = 1; i <= value.length; i++) {
    write(value.slice(0, i));
    keystrokes++;
  }
};

describe("log growth", () => {
  it("the §14 scenario: how many records, of which kinds, and what keystrokes would add", async () => {
    keystrokes = 0;
    const app = await start();
    // Todos: add, toggle, edit, compose, clear completed
    type(list(app).editNewTitle, "Water plants");
    toolbarAction(app, "Add").submit();
    list(app).toggle("t1");
    const form = openTodoEditor(app, "t2");
    type(form.editTitle, "Write the report");
    form.save.submit();
    await app.log.idle();
    app.menu("New todo…")?.submit();
    const create = editor(app, "new");
    create?.save.submit(); // fails: empty
    await app.log.idle();
    if (create) type(create.editTitle, "Plan trip");
    create?.save.submit();
    await app.log.idle();
    app.menu("Clear completed")?.submit();
    confirmDialog(app)?.confirm.submit();
    await app.log.idle();
    // Contacts: select, edit, fail, fix, link
    contactList(app).select("c1");
    contactAction(app, "Edit").submit();
    const c = contactEditor(app, "c1");
    if (c) type((v) => c.editField("name", v), " ");
    c?.save.submit();
    await app.log.idle();
    if (c) type((v) => c.editField("name", v), "Ada King");
    c?.save.submit();
    await app.log.idle();
    contactList(app).select("c3");
    contactAction(app, "New todo for this contact").submit();
    editor(app, "new")?.save.submit();
    await app.log.idle();

    const records = app.log.records();
    const byKind = { intents: 0, events: 0, outcomes: 0 };
    const byType: Record<string, number> = {};
    for (const r of records) {
      byType[r.type] = (byType[r.type] ?? 0) + 1;
      if (r.kind === "outcome") byKind.outcomes++;
      else if (r.type.endsWith(":select")) byKind.events++;
      else byKind.intents++;
    }
    const bytes = JSON.stringify(records).length;
    console.log(
      `[log growth] records=${records.length} ${JSON.stringify(byKind)} bytes=${bytes} keystrokes=${keystrokes}\n`,
      byType,
    );
    expect(records.length).toBe(app.log.stats().appended); // nothing pruned by default
    expect(records.length).toBeLessThan(80);
    expect(keystrokes).toBeGreaterThan(records.length / 2);
    await app.stop();
  });

  it("a long session with retain=200 stays bounded; the default keeps everything", async () => {
    for (const retain of [200, undefined]) {
      const app = await start(undefined, {
        setup: (context) => setIntentLog(context, createIntentLog({ retain })),
      });
      for (let i = 0; i < 1000; i++) list(app).toggle("t2");
      await app.log.idle();
      const { appended, retained } = app.log.stats();
      console.log(`[log growth] retain=${retain ?? "∞"} appended=${appended} retained=${retained}`);
      if (retain) expect(retained).toBeLessThanOrEqual(2 * retain);
      else expect(retained).toBe(appended);
      await app.stop();
    }
  });
});
