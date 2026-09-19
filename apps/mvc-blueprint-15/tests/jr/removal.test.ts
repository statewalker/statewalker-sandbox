import { without } from "@kernel";
import { afterEach, describe, expect, it } from "vitest";
import {
  coverageOf,
  errorLogs,
  type Running,
  start,
  until,
  workbenchHeadless,
} from "../support/harness.js";
import { titles } from "../support/scenarios.js";

/** Removing the technology, or the views, is an ordinary removal: gaps in the report, no error. */
describe("removal of the json-render layers", () => {
  let r: Running | undefined;
  afterEach(async () => {
    await r?.stop();
    r = undefined;
  });

  it("without jr.react: every published view is unrendered, nothing fails", async () => {
    const { manifest, removed } = without(workbenchHeadless, "jr.react");
    expect(removed).toEqual(["jr.react"]);
    r = await start(manifest);
    await until(() => titles(r as Running).length === 3);
    expect(coverageOf(r.context).unrendered.map((u) => u.kind)).toEqual([
      "todos:list",
      "contacts:list",
      "hello:panel",
    ]);
    // Nobody follows the views any more: the report says so.
    expect(coverageOf(r.context).unobserved).toContainEqual({
      slot: "ui.jr:views",
      contributions: 8,
    });
    expect(errorLogs(r.logs)).toEqual([]);
  });

  it("without the Todos views: only the Todos kinds are unrendered", async () => {
    const { manifest } = without(workbenchHeadless, "todos.jr");
    r = await start(manifest);
    await until(() => titles(r as Running).length === 3);
    expect(coverageOf(r.context).unrendered.map((u) => u.kind)).toEqual(["todos:list"]);
    expect(errorLogs(r.logs)).toEqual([]);
  });
});
