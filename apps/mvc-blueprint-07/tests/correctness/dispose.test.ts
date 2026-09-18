import { expect, it } from "vitest";
import type { TodosCollectionView } from "../../src/bundles/todos/api/index.js";
import { collectionSlot } from "../../src/bundles/todos/api/index.js";
import { start, tick } from "../support/headless.js";
import { nonEmptySlots } from "../support/slots.js";
import {
  contactAction,
  contactList,
  list,
  openTodoEditor,
  toolbarAction,
} from "../support/todos.js";

it("after the application's cleanup: slots empty, no handler or projection, no timer, no late write", async () => {
  const app = await start(undefined, { todoDelay: 30, notificationTimeout: 20 });
  const collection = app.slots.getSnapshot(collectionSlot)[0] as TodosCollectionView;
  let notified = 0;
  collection.onTodosUpdate(() => notified++);

  // leave everything open: an editor with a save in flight, a dialog, a toast, a contact editor
  const form = openTodoEditor(app, "t1");
  form.editTitle("in flight");
  form.save.submit();
  app.menu("Clear completed")?.submit();
  contactList(app).select("c1");
  contactAction(app, "Edit").submit();
  list(app).editNewTitle("x");
  toolbarAction(app, "Add").submit();
  const stale = list(app);
  const before = notified;

  await app.stop();
  expect(nonEmptySlots(app.slots)).toEqual([]);
  expect(app.log.stats()).toMatchObject({
    handlers: 0,
    projections: 0,
    pending: 0,
    openScopes: [],
  });

  const appended = app.log.stats().appended;
  await tick(60); // the api calls resolve late; the notification timer would have fired
  expect(app.log.stats().appended).toBe(appended); // nothing written after the late await
  expect(notified).toBe(before); // no model notifies

  // a stale view facet can still be called: nothing is appended, nothing throws
  stale.select("t2", false);
  stale.toggle("t2");
  form.save.submit();
  expect(app.log.stats().appended).toBe(appended);
  // the in-flight intents were failed by the log, visibly, not dropped
  const stopped = app.log
    .records()
    .filter((r) => r.kind === "outcome" && r.error?.startsWith("abandoned"));
  // the save had passed validation: its update reached the api before the stop, and is abandoned too
  expect(stopped.map((r) => r.type).sort()).toEqual([
    "todos.edit:save",
    "todos:add",
    "todos:update",
  ]);
  expect(app.errors()).toEqual([]);
});
