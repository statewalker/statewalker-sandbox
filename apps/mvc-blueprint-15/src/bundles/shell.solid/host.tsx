/** @jsxImportSource solid-js */
import {
  type DialogContribution,
  dialogsSlot,
  type HeaderContribution,
  headerSlot,
  type MenuContribution,
  menuSlot,
  type NotificationContribution,
  notificationsSlot,
  type PanelContribution,
  panelsSlot,
} from "@b/shell/api";
import { solidRenderersSlot } from "@b/shell/api/solid";
import type { KernelSlots, KeyedSlotDeclaration, SlotDeclaration } from "@kernel";
import { useModel } from "@kit/solid";
import { byOrder } from "@kit/slots";
import {
  type Accessor,
  type Component,
  createMemo,
  type JSX,
  createSignal,
  For,
  onCleanup,
  Show,
} from "solid-js";
import { Dynamic, render } from "solid-js/web";

type Slots = Pick<KernelSlots, "observe" | "getSnapshot">;

/** A slot as an accessor: the slots bus keeps the model contract, so the same binding applies. */
function useSlot<T>(slots: Slots, decl: SlotDeclaration<T>): Accessor<readonly T[]>;
function useSlot<T>(slots: Slots, decl: KeyedSlotDeclaration<T>): Accessor<ReadonlyMap<string, T>>;
function useSlot(
  slots: Slots,
  decl: SlotDeclaration<unknown> | KeyedSlotDeclaration<unknown>,
): Accessor<unknown> {
  const d = decl as SlotDeclaration<unknown>;
  return useModel(
    () => slots.getSnapshot(d),
    (cb) => slots.observe(d, () => cb()),
  );
}

export function mountShell(container: HTMLElement, slots: Slots): () => void {
  return render(() => <Shell slots={slots} />, container);
}

function Shell(props: { slots: Slots }) {
  const slots = props.slots;
  // Every subscription is made once, here, in the component's setup — never inside JSX, where an
  // expression re-runs and would subscribe again.
  const renderers = useSlot(slots, solidRenderersSlot);
  const menu = useSlot(slots, menuSlot);
  const header = useSlot(slots, headerSlot);
  const panels = useSlot(slots, panelsSlot);
  const dialogs = useSlot(slots, dialogsSlot);
  const notifications = useSlot(slots, notificationsSlot);
  /** A contribution whose kind has a renderer; otherwise nothing (the coverage report lists it). */
  const Rendered = (p: { contribution: PanelContribution | DialogContribution }) => (
    <Dynamic
      component={
        renderers().get(p.contribution.kind.id)?.component as
          | Component<{ model: unknown }>
          | undefined
      }
      model={p.contribution.model}
    />
  );
  return (
    <div class="flex min-h-screen flex-col">
      <div class="flex items-center gap-4 border-b px-4 py-2">
        <Menu items={menu} />
        <header data-shell="header" class="ml-auto flex gap-4 text-sm">
          <For each={byOrder(header())}>{(item) => <HeaderItem item={item} />}</For>
        </header>
      </div>
      <Panels panels={panels} Rendered={Rendered} />
      <Dialogs dialogs={dialogs} Rendered={Rendered} />
      <div data-shell="notifications" class="fixed right-4 bottom-4 flex flex-col gap-2">
        <For each={notifications()}>{(item) => <Toast item={item} />}</For>
      </div>
    </div>
  );
}

function HeaderItem(props: { item: HeaderContribution }) {
  const state = useModel(props.item.model.getState, props.item.model.onStateUpdate);
  return <span data-header-item={props.item.id}>{state().text}</span>;
}

function Menu(props: { items: Accessor<readonly MenuContribution[]> }) {
  const groups = createMemo(() => {
    const byGroup = new Map<string, { label: string; items: MenuContribution[] }>();
    for (const item of byOrder(props.items())) {
      const g = byGroup.get(item.group) ?? { label: item.groupLabel, items: [] };
      g.items.push(item);
      byGroup.set(item.group, g);
    }
    return [...byGroup].sort(([a], [b]) => a.localeCompare(b));
  });
  return (
    <nav aria-label="Main menu" class="flex gap-2">
      <For each={groups()}>
        {([group, { label, items }]) => (
          <details data-menu-group={group} class="relative">
            <summary class="cursor-pointer px-2">{label}</summary>
            <div role="menu" aria-label={label} class="absolute z-10 flex flex-col border bg-white">
              <For each={items}>{(item) => <MenuItem item={item} />}</For>
            </div>
          </details>
        )}
      </For>
    </nav>
  );
}

function MenuItem(props: { item: MenuContribution }) {
  const state = useModel(props.item.action.getState, props.item.action.onStateUpdate);
  return (
    <button
      type="button"
      role="menuitem"
      class="px-3 py-1 text-left disabled:opacity-50"
      disabled={!state().enabled || state().running}
      onClick={(event) => {
        props.item.action.submit();
        event.currentTarget.closest("details")?.removeAttribute("open");
      }}
    >
      {state().label}
    </button>
  );
}

type RenderedComponent = Component<{ contribution: PanelContribution | DialogContribution }>;

/**
 * Keyed by id, not by entry: a snapshot's `[id, contribution]` tuples are new arrays every time, and
 * `<For>` keys by reference — iterating the entries would re-create every panel on every change.
 */
function Panels(props: {
  panels: Accessor<ReadonlyMap<string, PanelContribution>>;
  Rendered: RenderedComponent;
}) {
  const [picked, setPicked] = createSignal<string | undefined>();
  const ids = (placement: "main" | "side") =>
    createMemo(
      () => {
        const entries = [...props.panels()];
        return entries
          .map(([id, p], index) => ({ id, p, index }))
          .filter(({ p }) => p.placement === placement)
          .sort((a, b) => (a.p.order ?? 0) - (b.p.order ?? 0) || a.index - b.index)
          .map(({ id }) => id);
      },
      [],
      { equals: (a, b) => a.length === b.length && a.every((id, i) => id === b[i]) },
    );
  const main = ids("main");
  const side = ids("side");
  const active = () => (main().includes(picked() as string) ? picked() : main()[0]);
  const { Rendered } = props;
  return (
    <div class="grid flex-1 grid-cols-1 gap-4 p-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
      <main>
        <div role="tablist" aria-label="Panels" class="mb-2 flex gap-2 border-b">
          <For each={main()}>
            {(id) => (
              <button
                type="button"
                role="tab"
                aria-selected={id === active()}
                class="px-3 py-1 aria-selected:border-b-2"
                onClick={() => setPicked(id)}
              >
                {props.panels().get(id)?.title}
              </button>
            )}
          </For>
        </div>
        <For each={main()}>
          {(id) => (
            <Show when={props.panels().get(id)} keyed>
              {(p) => (
                <section
                  role="tabpanel"
                  data-panel={id}
                  aria-label={p.title}
                  hidden={id !== active()}
                >
                  <Rendered contribution={p} />
                </section>
              )}
            </Show>
          )}
        </For>
      </main>
      <aside class="flex flex-col gap-4">
        <For each={side()}>
          {(id) => (
            <Show when={props.panels().get(id)} keyed>
              {(p) => (
                <section data-panel={id} aria-label={p.title} class="rounded border p-3">
                  <h2 class="mb-2 font-semibold">{p.title}</h2>
                  <Rendered contribution={p} />
                </section>
              )}
            </Show>
          )}
        </For>
      </aside>
    </div>
  );
}

function Dialogs(props: {
  dialogs: Accessor<ReadonlyMap<string, DialogContribution>>;
  Rendered: RenderedComponent;
}) {
  const ids = createMemo(() => [...props.dialogs().keys()], [], {
    equals: (a, b) => a.length === b.length && a.every((id, i) => id === b[i]),
  });
  const { Rendered } = props;
  return (
    <For each={ids()}>
      {(id, index) => (
        <Show when={props.dialogs().get(id)} keyed>
          {(d) => (
            <FocusReturn>
              <div
                class="fixed inset-0 flex items-center justify-center bg-black/30"
                style={{ "z-index": 50 + index() }}
              >
                <div
                  role="dialog"
                  aria-modal="true"
                  aria-label={d.title}
                  data-dialog={id}
                  class="rounded bg-white p-4 shadow"
                >
                  <h2 class="mb-2 font-semibold">{d.title}</h2>
                  <Rendered contribution={d} />
                </div>
              </div>
            </FocusReturn>
          )}
        </Show>
      )}
    </For>
  );
}

/**
 * The last element that received focus. The browser blurs an opener that gets disabled while its
 * dialog is open (Clear completed shows `running`), so `activeElement` at open time can be <body>.
 */
let lastFocused: Element | null = null;
if (typeof document !== "undefined") {
  document.addEventListener("focusin", (event) => {
    if (!(event.target as Element).closest?.('[role="dialog"]'))
      lastFocused = event.target as Element;
  });
}

/** Remembers the opener when a dialog appears; puts focus back when it is withdrawn. */
function FocusReturn(props: { children: JSX.Element }) {
  const opener = document.activeElement !== document.body ? document.activeElement : lastFocused;
  onCleanup(() => {
    // After the withdrawal has rendered: the opener may have been disabled while the dialog ran.
    setTimeout(() => {
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    }, 0);
  });
  return <>{props.children}</>;
}

function Toast(props: { item: NotificationContribution }) {
  const state = useModel(props.item.model.getState, props.item.model.onStateUpdate);
  return (
    <div
      data-notification={props.item.id}
      data-tone={state().tone}
      role={state().tone === "error" ? "alert" : "status"}
      class="flex items-center gap-2 rounded border bg-white px-3 py-2 shadow"
    >
      <span>{state().message}</span>
      <button type="button" aria-label="Dismiss" onClick={() => props.item.model.dismiss()}>
        ×
      </button>
    </div>
  );
}
