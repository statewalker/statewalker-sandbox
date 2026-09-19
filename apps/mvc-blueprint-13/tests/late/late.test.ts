import { panelsSlot } from "@p5/shell/api";
import { reactRenderersSlot } from "@p5/shell/api/react";
import todosCore from "@p5/todos.core";
import todosStatus from "@p5/todos.status";
import todosUiReact from "@p5/todos.ui.react";
import {
  type ApplicationManifest,
  application,
  type Context,
  getSlots,
  loggerAdapter,
} from "@p5/kernel";
import { createCoverage } from "@p5/kit-host";
import { describe, expect, it } from "vitest";
import { activateAlone } from "../support/activate.js";
import { contacts, todos } from "../../src/features/logic.js";
import { contactsReact } from "../../src/features/react.js";
import { header, headlessShellFeature, settle, until } from "../support/harness.js";
import { newRecordingLogger } from "../support/logging.js";

const quiet = (): Context => {
  const ctx: Context = {};
  loggerAdapter.set(ctx, newRecordingLogger().logger);
  return ctx;
};

describe("late subscribers: any arrival order works", () => {
  it("todos.status activated BEFORE todos.core still shows the count", async () => {
    const app: ApplicationManifest = {
      id: "status-first",
      features: [
        {
          id: "f",
          bundles: [
            { id: "todos.status", module: { default: todosStatus } },
            { id: "todos.core", module: { default: todosCore }, provides: ["todos:api"] },
          ],
        },
      ],
    };
    const ctx = quiet();
    const stop = await application(app)(ctx);
    await until(() => header(getSlots(ctx)).includes("2 open todos"));
    await stop?.();
  });

  it("model before renderer, and renderer before model: both render (coverage closes the gap)", async () => {
    // Model first: the list panel is published with no renderer — a gap in the report, no error.
    const ctx = quiet();
    const slots = getSlots(ctx);
    const coverage = createCoverage(slots, reactRenderersSlot);
    const stopTodos = await application({ id: "logic", features: [todos] })(ctx);
    expect(coverage.getReport().unrendered.map((u) => u.id)).toEqual(["todos:list"]);
    // The renderer arrives later: the gap closes without touching the model.
    const stopUi = await activateAlone(todosUiReact, ctx);
    expect(coverage.getReport().unrendered).toEqual([]);
    expect(slots.getSnapshot(reactRenderersSlot).has("todos:list")).toBe(true);
    await stopUi?.();
    await stopTodos?.();

    // Renderer first: nothing to show yet; the model arrives and is rendered.
    const ctx2 = quiet();
    const slots2 = getSlots(ctx2);
    const coverage2 = createCoverage(slots2, reactRenderersSlot);
    const stopUi2 = await activateAlone(todosUiReact, ctx2);
    expect(slots2.getSnapshot(panelsSlot).size).toBe(0);
    const stopTodos2 = await application({ id: "logic", features: [todos] })(ctx2);
    expect(slots2.getSnapshot(panelsSlot).has("todos:list")).toBe(true);
    expect(coverage2.getReport().unrendered).toEqual([]);
    await stopTodos2?.();
    await stopUi2?.();
    coverage.dispose();
    coverage2.dispose();
  });

  it("a feature activated after the shell appears without a reload, and leaves cleanly", async () => {
    const ctx = quiet();
    const stopShell = await application({ id: "shell-only", features: [headlessShellFeature] })(
      ctx,
    );
    const slots = getSlots(ctx);
    expect(slots.getSnapshot(panelsSlot).size).toBe(0);
    const stopContacts = await application({
      id: "contacts-later",
      features: [contacts, contactsReact],
    })(ctx);
    await settle();
    expect([...slots.getSnapshot(panelsSlot).keys()]).toEqual(["contacts:list"]);
    await stopContacts?.();
    expect(slots.getSnapshot(panelsSlot).size).toBe(0);
    await stopShell?.();
  });
});
