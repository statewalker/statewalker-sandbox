import { describe, expect, it } from "vitest";
import type { Todo, TodosCollectionView } from "../../src/bundles/todos/api/index.js";
import { collectionSlot } from "../../src/bundles/todos/api/index.js";
import { foldTodos } from "../../src/bundles/todos.core/index.js";
import { createIntentLog, getIntentLog, setIntentLog } from "../../src/kernel/log.js";
import { start } from "../support/headless.js";
import { list, toolbarAction } from "../support/todos.js";

/**
 * "Is todos:collection a projection anyone may build?" — technically yes: replay the log through
 * the same fold. This pins what it costs: the fold is IMPLEMENTATION (todos.core's), and the replay
 * is only correct while the log retains every record since the load.
 */
describe("who owns shared state", () => {
  const exercise = async (retain?: number) => {
    const app = await start(undefined, {
      setup: (context) => setIntentLog(context, createIntentLog({ retain })),
    });
    for (const title of ["a", "b", "c", "d", "e", "f"]) {
      list(app).editNewTitle(title);
      toolbarAction(app, "Add").submit();
      list(app).select("t1", false);
    }
    await app.log.idle();
    const owner = (app.slots.getSnapshot(collectionSlot)[0] as TodosCollectionView).getTodos();
    // a latecomer builds its own copy by replaying the log through the owner's fold
    let mine: readonly Todo[] = [];
    getIntentLog(app.context)
      .open("latecomer")
      .project((r) => (mine = foldTodos(mine, r)), { replay: true });
    await app.stop();
    return { owner, mine };
  };

  it("with the whole log retained, a replayed projection equals the owner's", async () => {
    const { owner, mine } = await exercise();
    expect(mine).toEqual(owner);
  });

  it("once the log is compacted, the replayed projection silently diverges", async () => {
    const { owner, mine } = await exercise(8);
    expect(owner).toHaveLength(9);
    expect(mine).not.toEqual(owner); // the load outcome was pruned
  });
});
