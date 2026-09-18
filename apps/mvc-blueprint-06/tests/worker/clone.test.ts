/**
 * Could a bundle move to a worker without code changes? Run everything with the clone check on:
 * every message, reply and stream value is structured-cloned, and failures are recorded.
 */
import { describe, expect, it } from "vitest";
import { workbenchHeadless } from "../../src/apps/index.js";
import { reactRenderers } from "../../src/bundles/shell/api/react.js";
import { todosUiReactBundle } from "../../src/bundles/todos.ui.react/index.js";
import { ActorSystem, ownPoints } from "../../src/kernel/index.js";
import {
  contactsBasics,
  headerCount,
  newTodoForContact,
  todosBasics,
} from "../scenario/scenario.js";
import { start } from "../support/headless.js";

describe("worker readiness (structured clone of everything that crosses a mailbox)", () => {
  it("every logic bundle's messages, replies and streams are cloneable across the whole scenario", async () => {
    for (const run of [todosBasics, contactsBasics, newTodoForContact, headerCount]) {
      const h = await start(workbenchHeadless({ notifyTimeoutMs: 60_000 }), { cloneCheck: true });
      await run(h);
      expect(h.system.cloneFailures).toEqual([]);
      await h.stop();
    }
  });

  it("a UI bundle's renderer contribution is NOT cloneable: UI bundles stay on the main thread", async () => {
    const system = new ActorSystem({ cloneCheck: true, logSink: () => {} });
    system.spawn("shell.react", (ctx) => {
      const points = ownPoints(ctx, [reactRenderers]);
      return (m, env) => void points.handle(m, env);
    });
    system.spawn(todosUiReactBundle.id, todosUiReactBundle.behavior as never);
    // Three contribute messages, and the renderer point's stream after each.
    expect(new Set(system.cloneFailures.map((f) => f.where))).toEqual(
      new Set(["todos.ui.react → shell.react", "ui.react:renderers"]),
    );
  });
});
