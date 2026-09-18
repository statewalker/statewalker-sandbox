import { afterEach, expect, it } from "vitest";
import type { RenameView } from "../../src/bundles/todos/api/index.js";
import { type Probe, start } from "../support/headless.js";
import { list, selectionAction, titles } from "../support/todos.js";

let app: Probe;
afterEach(async () => app?.stop());
const dialog = () => app.dialog<RenameView>("todos:rename");

it("Rename… is enabled with exactly one todo selected", async () => {
  app = await start();
  const rename = selectionAction(app, "Rename…");
  expect(rename.getState().enabled).toBe(false);
  list(app).select("t1", false);
  expect(rename.getState().enabled).toBe(true);
  list(app).select("t2", true);
  expect(rename.getState().enabled).toBe(false);
});

it("renames at commit time and withdraws the dialog; an empty title is refused with a form error", async () => {
  app = await start(undefined, { todoDelay: 10 });
  list(app).select("t2", false);
  selectionAction(app, "Rename…").submit();
  const d = dialog();
  expect(d?.getDraft().title).toBe("Write report");
  d?.editTitle("  ");
  d?.rename.submit();
  await app.log.idle();
  expect(d?.getStatus().error).toBe("Title is required");
  d?.editTitle("Write the summary");
  d?.rename.submit();
  d?.editTitle("typed after"); // belongs to no commit
  await app.log.idle();
  expect(titles(app)[1]).toBe("Write the summary");
  expect(dialog()).toBeUndefined();
});
