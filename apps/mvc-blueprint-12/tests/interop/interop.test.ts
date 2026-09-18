import { MessageChannel } from "node:worker_threads";
import { headerSlot, type HeaderItemView } from "@b/shell/api";
import { activate as todosCore } from "@b/todos.core";
import { activate as todosStatus } from "@b/todos.status";
import {
  type Todo,
  type TodoCounts,
  type TodosCollectionView,
  todosAdd,
  todosCollectionSlot,
} from "@b/todos/api";
import {
  application,
  type Context,
  type Controller,
  computed,
  fromChannel,
  getCommands,
  getSlots,
  type Listener,
  loggerAdapter,
  readable,
} from "@kernel";
import { followFirst } from "@kit/slots";
import { describe, expect, it } from "vitest";
import { newRecordingLogger } from "../support/logging.js";
import { until } from "../support/harness.js";

/**
 * P4 — does a bundle on a DIFFERENT substrate (plain listeners) still interoperate with bundles
 * on the shared graph? Three directions, plus a realm boundary.
 */

const quiet = (): Context => {
  const ctx: Context = {};
  loggerAdapter.set(ctx, newRecordingLogger().logger);
  return ctx;
};
const headerTexts = (ctx: Context) =>
  getSlots(ctx)
    .getSnapshot(headerSlot)
    .map((h) => h.model.getState().text);
const statusText = (ctx: Context) =>
  getSlots(ctx)
    .getSnapshot(headerSlot)
    .find((h) => h.id === "todos.status")
    ?.model.getState().text;

/** A hand-rolled todos store: a value and a listener set — no reactive library at all. */
function plainTodos(initial: readonly Todo[]) {
  let todos = initial;
  const listeners = new Set<Listener>();
  return {
    get: () => todos,
    on(listener: Listener) {
      listeners.add(listener);
      listener();
      return () => void listeners.delete(listener);
    },
    set(next: readonly Todo[]) {
      todos = Object.freeze([...next]);
      for (const l of [...listeners]) l();
    },
  };
}

const countsOf = (todos: readonly Todo[]): TodoCounts => {
  const done = todos.filter((t) => t.done).length;
  return { open: todos.length - done, done };
};

/** A `todos:collection` owner NOT on the substrate: it must bridge into it to publish at all. */
function plainOwner(store: ReturnType<typeof plainTodos>): Controller {
  return async (ctx) => {
    const bridge = fromChannel(store.get, store.on);
    let last: TodoCounts | undefined;
    const counts = readable(
      computed(() => {
        const next = countsOf(bridge.read());
        if (last && last.open === next.open && last.done === next.done) return last;
        last = next;
        return next;
      }),
    );
    const view: TodosCollectionView = Object.freeze({ todos: bridge.read, counts });
    const withdraw = getSlots(ctx).provide(todosCollectionSlot, view);
    return () => {
      withdraw();
      bridge.stop();
    };
  };
}

/** A `todos.status` written WITHOUT the substrate: only `.subscribe` on the published facet. */
const plainStatus: Controller = async (ctx) => {
  const slots = getSlots(ctx);
  let state = { text: "" };
  const listeners = new Set<Listener>();
  const model: HeaderItemView = {
    getState: () => state,
    onStateUpdate(listener) {
      listeners.add(listener);
      listener();
      return () => void listeners.delete(listener);
    },
  };
  return followFirst(slots, todosCollectionSlot, (c) => {
    const off = c.counts.subscribe(() => {
      const text = `${c.counts().open} open (plain)`;
      if (text === state.text) return;
      state = { text };
      for (const l of [...listeners]) l();
    });
    const withdraw = slots.provide(headerSlot, { id: "plain.status", order: 20, model });
    return () => {
      withdraw();
      off();
    };
  });
};

const seed: readonly Todo[] = [
  { id: "a", title: "a", done: false },
  { id: "b", title: "b", done: false },
  { id: "c", title: "c", done: true },
];

describe("interop: a plain-listener bundle next to the shared substrate", () => {
  it("plain CONSUMER: follows a substrate owner through `.subscribe` alone", async () => {
    const ctx = quiet();
    const stop = await application({
      id: "plain-consumer",
      features: [
        {
          id: "f",
          bundles: [
            { id: "plain.status", activator: plainStatus },
            { id: "todos.core", activator: todosCore, provides: ["todos:api"] },
            { id: "todos.status", activator: todosStatus },
          ],
        },
      ],
    })(ctx);
    await until(() => headerTexts(ctx).includes("2 open (plain)"));
    expect(headerTexts(ctx).sort()).toEqual(["2 open (plain)", "2 open todos"]);
    await stop?.();
  });

  it("plain PRODUCER: substrate consumers follow it once it is bridged with `fromChannel`", async () => {
    const store = plainTodos(seed);
    const ctx = quiet();
    const stop = await application({
      id: "plain-producer",
      features: [
        {
          id: "f",
          bundles: [
            { id: "plain.owner", activator: plainOwner(store) },
            { id: "todos.status", activator: todosStatus },
          ],
        },
      ],
    })(ctx);
    expect(statusText(ctx)).toBe("2 open todos");
    store.set([...seed, { id: "d", title: "d", done: false }]);
    expect(statusText(ctx)).toBe("3 open todos"); // synchronous, like P0
    await stop?.();
  });

  it("…but glitch-freedom stops at the bridge: a listener subscribed before it reads a stale derivation", async () => {
    const store = plainTodos(seed);
    const ctx = quiet();
    const seen: string[] = [];
    // A plain-listener bundle subscribed to the producer BEFORE the owner bridged it.
    store.on(() => {
      const text = statusText(ctx);
      if (text !== undefined) seen.push(`${store.get().filter((t) => !t.done).length}|${text}`);
    });
    const stop = await application({
      id: "bridge-glitch",
      features: [
        {
          id: "f",
          bundles: [
            { id: "plain.owner", activator: plainOwner(store) },
            { id: "todos.status", activator: todosStatus },
          ],
        },
      ],
    })(ctx);
    store.set([...seed, { id: "d", title: "d", done: false }]);
    // The early listener ran before the bridge wrote its signal: it saw 3 open rows but "2 open".
    expect(seen).toEqual(["3|2 open todos"]);
    await stop?.();
  });

  it("another REALM: the owner's Readable cannot cross; a proxy bridges a message stream (async)", async () => {
    // "Worker" side: the real owner (todos.core) on ITS kernel graph, posting snapshots.
    const channel = new MessageChannel();
    const workerCtx = quiet();
    const stopWorker = await application({
      id: "worker",
      features: [
        { id: "w", bundles: [{ id: "todos.core", activator: todosCore, provides: ["todos:api"] }] },
      ],
    })(workerCtx);
    const [owner] = getSlots(workerCtx).getSnapshot(todosCollectionSlot);
    if (!owner) throw new Error("no owner");
    const offPost = owner.todos.subscribe(() => channel.port1.postMessage(owner.todos()));

    // Main side: a proxy bundle turns the stream back into a Readable (structured clones: every
    // message is a NEW array: identity — contract point 7 — is lost at the hop; this proxy does
    // not restore it, the consumers' stable groups absorb it).
    let latest: readonly Todo[] = [];
    const listeners = new Set<Listener>();
    channel.port2.on("message", (todos: readonly Todo[]) => {
      latest = Object.freeze(todos);
      for (const l of [...listeners]) l();
    });
    const proxyStore = {
      get: () => latest,
      on(l: Listener) {
        listeners.add(l);
        l();
        return () => void listeners.delete(l);
      },
    };
    const ctx = quiet();
    const stop = await application({
      id: "main",
      features: [
        {
          id: "m",
          bundles: [
            { id: "proxy", activator: plainOwner({ ...proxyStore, set: () => {} }) },
            { id: "todos.status", activator: todosStatus },
          ],
        },
      ],
    })(ctx);
    await until(() => statusText(ctx) === "2 open todos");
    // A write on the worker side has landed there (the command resolved after the owner
    // published) but is NOT yet visible on the main side: the derivation lags by a message hop.
    await getCommands(workerCtx).call(todosAdd, { title: "from the worker" }).promise;
    expect(owner.counts().open).toBe(3);
    expect(statusText(ctx)).toBe("2 open todos");
    await until(() => statusText(ctx) === "3 open todos");
    offPost();
    channel.port1.close();
    channel.port2.close();
    await stop?.();
    await stopWorker?.();
  });
});
