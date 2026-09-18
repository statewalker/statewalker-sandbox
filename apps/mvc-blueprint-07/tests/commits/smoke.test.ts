import { expect, it } from "vitest";
import type { TodosListView } from "../../src/bundles/todos/api/index.js";
import { start } from "../support/headless.js";

it("the headless workbench starts, shows the count and stops clean", async () => {
  const app = await start();
  expect(app.header()).toEqual(["2 open todos"]);
  const list = app.panel<TodosListView>("todos:list");
  expect(list?.getItems().map((t) => t.title)).toEqual([
    "Buy milk",
    "Write report",
    "Call plumber",
  ]);
  await app.stop();
  expect(app.log.stats().openScopes).toEqual([]);
  expect(app.errors()).toEqual([]);
});
