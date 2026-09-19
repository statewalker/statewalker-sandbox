import { headlessShell } from "@p5/shell.test";
import type { ContactListView } from "@p5/contacts/api";
import { dialogsSlot, headerSlot, panelsSlot } from "@p5/shell/api";
import { reactRenderersSlot } from "@p5/shell/api/react";
import type { ConfirmView, TodoListView } from "@p5/todos/api";
import {
  type ActionView,
  application,
  type Context,
  getSlots,
  loggerAdapter,
  type Scope,
} from "@p5/kernel";
import { describe, expect, it } from "vitest";
import {
  contacts,
  hello,
  todos,
  todosContacts,
  todosStatusFeature,
} from "../../src/features/logic.js";

/**
 * GLITCH TEST — a value derived across two bundles never shows an intermediate state.
 *
 * P4's test, unchanged but for imports. Black-box: it reads only what a renderer reads (published
 * view models). P0: 11 violations with early observers; P4 (shared substrate): 0; K: kit `track`. Inside EVERY notification of every
 * observed model it checks four cross-bundle invariants; a violation is a glitch a renderer (or a
 * listener in another bundle) could have painted or acted on:
 *
 *   I1 header "N open todos" (todos.status)      == open rows in the list (todos.list)
 *   I2 "New todo for this contact" enabled        == a contact is selected (contacts.list)
 *   I3 "Rename…" enabled (todos.rename)           == exactly one row selected (todos.list)
 *   I4 "Clear completed" enabled                   == some row is done (todos.list)
 *   I0 control: Toggle enabled (same model)       == some row selected — intra-model, must hold
 *
 * I1–I4 cross a bundle boundary through shared state (`todos:collection`, `todos:selection`,
 * `contacts:selection`). The observers are subscribed in two orders: "late" (after activation, as
 * a renderer mounts) and "early" (a bundle activated before the owners, as a header item or a
 * dashboard bundle would be).
 */

const noop = () => {};
const quiet = (): Context => {
  const ctx: Context = {};
  const logger = {
    level: "warn",
    trace: noop,
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    fatal: noop,
    child: () => logger,
  };
  loggerAdapter.set(ctx, logger as never);
  return ctx;
};

const until = async (predicate: () => boolean, timeoutMs = 2000) => {
  const t0 = Date.now();
  while (!predicate()) {
    if (Date.now() - t0 > timeoutMs) throw new Error("until: timed out");
    await new Promise((r) => setTimeout(r, 1));
  }
};

interface Probe {
  readonly violations: string[];
  checks: number;
  /**
   * Subscribes the invariant check to every observed model that exists now; call again when more
   * appear (idempotent per model). Missing pieces are skipped by the check.
   */
  attach(): void;
  /** True once every observed model is subscribed. */
  complete(): boolean;
  detach(): void;
}

function newProbe(ctx: Context): Probe {
  const slots = getSlots(ctx);
  const violations: string[] = [];
  const panels = () => slots.getSnapshot(panelsSlot);
  const todoList = () => panels().get("todos:list")?.model as TodoListView | undefined;
  const contactList = () => panels().get("contacts:list")?.model as ContactListView | undefined;
  const headerItem = () => slots.getSnapshot(headerSlot).find((h) => h.id === "todos.status");
  const find = (items: readonly { action: ActionView }[] | undefined, label: string) =>
    items?.find((a) => a.action.getState().label === label)?.action;
  const link = () => find(contactList()?.getSelectionActions(), "New todo for this contact");
  const rename = () => find(todoList()?.getSelectionActions(), "Rename…");
  const clear = () => find(todoList()?.getToolbar(), "Clear completed");

  const check = (where: string) => () => {
    probe.checks++;
    const list = todoList();
    const clist = contactList();
    const head = headerItem();
    const items = list?.getItems();
    if (items && head) {
      const open = items.filter((t) => !t.done).length;
      const text = head.model.getState().text;
      if (text !== `${open} open todos`)
        violations.push(`I1 @${where}: header "${text}" vs ${open} open rows`);
    }
    const l = link();
    if (clist && l) {
      const hasContact = clist.getSelectedId() !== undefined;
      if (l.getState().enabled !== hasContact)
        violations.push(
          `I2 @${where}: link enabled=${l.getState().enabled}, selected=${hasContact}`,
        );
    }
    const r = rename();
    if (list && r) {
      const one = list.getSelection().length === 1;
      if (r.getState().enabled !== one)
        violations.push(`I3 @${where}: rename enabled=${r.getState().enabled}, one=${one}`);
    }
    const c = clear();
    if (items && c) {
      const anyDone = items.some((t) => t.done);
      if (c.getState().enabled !== anyDone)
        violations.push(`I4 @${where}: clear enabled=${c.getState().enabled}, done=${anyDone}`);
    }
    if (list) {
      const some = list.getSelection().length > 0;
      if (list.toggle.getState().enabled !== some)
        violations.push(`I0 @${where}: toggle enabled=${list.toggle.getState().enabled}`);
    }
  };

  const attached = new Map<unknown, () => void>();
  const once = (key: unknown, subscribe: () => () => void) => {
    if (key === undefined || attached.has(key)) return;
    attached.set(key, () => {}); // before subscribing: the immediate callback may re-enter
    attached.set(key, subscribe());
  };
  const probe: Probe = {
    violations,
    checks: 0,
    attach() {
      const list = todoList();
      const clist = contactList();
      const head = headerItem();
      if (list) {
        once(list, () => {
          const offs = [
            list.onItemsUpdate(check("list.items")),
            list.onSelectionUpdate(check("list.selection")),
            list.toggle.onStateUpdate(check("toggle")),
            // actions arrive later: attach them when they are folded in
            list.onToolbarUpdate(() => probe.attach()),
            list.onSelectionActionsUpdate(() => probe.attach()),
          ];
          return () => {
            for (const off of offs) off();
          };
        });
      }
      if (clist) {
        once(clist, () => {
          const offs = [
            clist.onSelectedIdUpdate(check("contacts.selectedId")),
            clist.onSelectionActionsUpdate(() => probe.attach()),
          ];
          return () => {
            for (const off of offs) off();
          };
        });
      }
      if (head) once(head.model, () => head.model.onStateUpdate(check("header")));
      const l = link();
      if (l) once(l, () => l.onStateUpdate(check("link")));
      const r = rename();
      if (r) once(r, () => r.onStateUpdate(check("rename")));
      const c = clear();
      if (c) once(c, () => c.onStateUpdate(check("clear")));
    },
    // 6 observed models with Rename present, 5 without.
    complete: () => attached.size === (rename() ? 6 : 5),
    detach() {
      for (const off of attached.values()) off();
      attached.clear();
    },
  };
  return probe;
}

/** The workbench's logic, headless; `observer` (if any) is activated FIRST. */
async function run(order: "late" | "early") {
  const ctx = quiet();
  const probe = newProbe(ctx);
  const observer = {
    id: "observer",
    bundles: [
      {
        id: "observer",
        activator: async (context: Context, scope: Scope) => {
          // Early: subscribe to each model the moment it is published — before the bundles that
          // derive from it (status, link, rename, clear-completed) have subscribed.
          const slots = getSlots(context);
          scope.defer(slots.observe(panelsSlot, () => probe.attach()));
          scope.defer(slots.observe(headerSlot, () => probe.attach()));
        },
      },
    ],
  };
  const features = [
    ...(order === "early" ? [observer] : []),
    { id: "shell", bundles: [{ id: "shell.test", activator: headlessShell(reactRenderersSlot) }] },
    todos,
    todosStatusFeature,
    contacts,
    todosContacts,
    hello,
  ];
  const stop = await application({ id: `glitch.${order}`, features })(ctx);
  const list = () => getSlots(ctx).getSnapshot(panelsSlot).get("todos:list")?.model as TodoListView;
  const clist = () =>
    getSlots(ctx).getSnapshot(panelsSlot).get("contacts:list")?.model as ContactListView;
  await until(() => list()?.getItems().length === 3 && clist()?.getContacts().length === 3);
  if (order === "late") probe.attach();
  await until(() => probe.complete());
  probe.violations.length = 0; // count only what the scenario provokes

  // ── the scenario: every step changes shared state another bundle derives from ──────────────
  const L = list();
  const ids = L.getItems().map((t) => t.id);
  const done = async () => new Promise((r) => setTimeout(r, 0));
  L.select([ids[0] as string]);
  L.select([ids[0] as string, ids[1] as string]);
  L.select([]);
  L.select([ids[1] as string]); // "Write report" (open)
  L.toggle.submit(); // → done: counts and "Clear completed" change
  await until(() => L.getItems().filter((t) => t.done).length === 2);
  L.setNewTitle("Glitch me");
  L.getToolbar()
    .find((a) => a.action.getState().label === "Add")
    ?.action.submit();
  await until(() => L.getItems().length === 4);
  const fresh = L.getItems().find((t) => t.title === "Glitch me")?.id as string;
  L.select([fresh]);
  L.getSelectionActions()
    .find((a) => a.action.getState().label === "Delete")
    ?.action.submit(); // the selected row disappears: selection AND counts change at once
  await until(() => L.getItems().length === 3);
  L.getToolbar()
    .find((a) => a.action.getState().label === "Clear completed")
    ?.action.submit();
  await until(() => getSlots(ctx).getSnapshot(panelsSlot) && dialogOpen(ctx));
  (dialogModel(ctx) as ConfirmView).confirm.submit();
  await until(() => L.getItems().every((t) => !t.done));
  const C = clist();
  C.select("c1");
  C.select("c2");
  C.select(undefined);
  C.select("c3");
  await done();

  const result = { violations: [...probe.violations], checks: probe.checks };
  probe.detach();
  await stop?.();
  return result;
}

const dialogOpen = (ctx: Context) =>
  getSlots(ctx).getSnapshot(dialogsSlot).has("todos:clear-completed");
const dialogModel = (ctx: Context) =>
  getSlots(ctx).getSnapshot(dialogsSlot).get("todos:clear-completed")?.model;

const summarize = (violations: readonly string[]) => {
  const byInvariant: Record<string, number> = {};
  for (const v of violations) {
    const key = v.slice(0, 2);
    byInvariant[key] = (byInvariant[key] ?? 0) + 1;
  }
  return byInvariant;
};

describe("glitch: cross-bundle derived values never show an intermediate state", () => {
  for (const order of ["late", "early"] as const) {
    it(`observers subscribed ${order}`, async () => {
      const { violations, checks } = await run(order);
      console.log(
        `[glitch P5 ${order}] checks=${checks} violations=${violations.length}`,
        JSON.stringify(summarize(violations)),
        violations.slice(0, 12),
      );
      expect(violations).toEqual([]);
    });
  }
});
