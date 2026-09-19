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
} from "@p5/shell/api";
import { type ReactRenderer, reactRenderersSlot } from "@p5/shell/api/react";
import type { KernelSlots, KeyedSlotDeclaration, SlotDeclaration } from "@p5/kernel";
import type { FocusReturn } from "@p5/kit-host";
import { useModel } from "@p5/kit-react";
import { byOrder } from "@p5/kit-slots";
import {
  type ComponentType,
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";

type Slots = Pick<KernelSlots, "observe" | "getSnapshot">;
const SlotsContext = createContext<Slots | null>(null);
const FocusContext = createContext<FocusReturn | null>(null);

function useSlots(): Slots {
  const slots = useContext(SlotsContext);
  if (!slots) throw new Error("no slots");
  return slots;
}

function useSlot<T>(decl: SlotDeclaration<T>): readonly T[] {
  const slots = useSlots();
  const subscribe = useCallback((cb: () => void) => slots.observe(decl, () => cb()), [slots, decl]);
  const read = useCallback(() => slots.getSnapshot(decl), [slots, decl]);
  return useSyncExternalStore(subscribe, read, read);
}

function useKeyedSlot<T>(decl: KeyedSlotDeclaration<T>): ReadonlyMap<string, T> {
  const slots = useSlots();
  const subscribe = useCallback((cb: () => void) => slots.observe(decl, () => cb()), [slots, decl]);
  const read = useCallback(() => slots.getSnapshot(decl), [slots, decl]);
  return useSyncExternalStore(subscribe, read, read);
}

function useRenderer(kindId: string): ComponentType<{ model: unknown }> | undefined {
  const renderers = useKeyedSlot(reactRenderersSlot);
  return (renderers.get(kindId) as ReactRenderer<unknown> | undefined)?.component;
}

/** A contribution whose kind has a renderer; otherwise nothing (the coverage report lists it). */
function Rendered({ contribution }: { contribution: PanelContribution | DialogContribution }) {
  const Component = useRenderer(contribution.kind.id);
  return Component ? <Component model={contribution.model} /> : null;
}

export function Shell({ slots, focus }: { slots: Slots; focus: FocusReturn }) {
  return (
    <SlotsContext.Provider value={slots}>
      <FocusContext.Provider value={focus}>
        <div className="flex min-h-screen flex-col">
          <div className="flex items-center gap-4 border-b px-4 py-2">
            <Menu />
            <Header />
          </div>
          <Panels />
          <Dialogs />
          <Notifications />
        </div>
      </FocusContext.Provider>
    </SlotsContext.Provider>
  );
}

function HeaderItem({ item }: { item: HeaderContribution }) {
  const state = useModel(item.model.getState, item.model.onStateUpdate);
  return <span data-header-item={item.id}>{state.text}</span>;
}

function Header() {
  const items = byOrder(useSlot(headerSlot));
  return (
    <header data-shell="header" className="ml-auto flex gap-4 text-sm">
      {items.map((item) => (
        <HeaderItem key={item.id} item={item} />
      ))}
    </header>
  );
}

function Menu() {
  const items = useSlot(menuSlot);
  const groups = useMemo(() => {
    const byGroup = new Map<string, { label: string; items: MenuContribution[] }>();
    for (const item of byOrder(items)) {
      const g = byGroup.get(item.group) ?? { label: item.groupLabel, items: [] };
      g.items.push(item);
      byGroup.set(item.group, g);
    }
    return [...byGroup].sort(([a], [b]) => a.localeCompare(b));
  }, [items]);
  return (
    <nav aria-label="Main menu" className="flex gap-2">
      {groups.map(([group, { label, items: entries }]) => (
        <details key={group} data-menu-group={group} className="relative">
          <summary className="cursor-pointer px-2">{label}</summary>
          <div
            role="menu"
            aria-label={label}
            className="absolute z-10 flex flex-col border bg-white"
          >
            {entries.map((item) => (
              <MenuItem key={item.id} item={item} />
            ))}
          </div>
        </details>
      ))}
    </nav>
  );
}

function MenuItem({ item }: { item: MenuContribution }) {
  const state = useModel(item.action.getState, item.action.onStateUpdate);
  return (
    <button
      type="button"
      role="menuitem"
      className="px-3 py-1 text-left disabled:opacity-50"
      disabled={!state.enabled || state.running}
      onClick={(event) => {
        item.action.submit();
        event.currentTarget.closest("details")?.removeAttribute("open");
      }}
    >
      {state.label}
    </button>
  );
}

function Panels() {
  const panels = useKeyedSlot(panelsSlot);
  const [picked, setPicked] = useState<string | undefined>();
  const entries = [...panels];
  const main = entries
    .map(([id, p], index) => ({ id, p, index }))
    .filter(({ p }) => p.placement === "main")
    .sort((a, b) => (a.p.order ?? 0) - (b.p.order ?? 0) || a.index - b.index);
  const side = entries
    .filter(([, p]) => p.placement === "side")
    .sort(([, a], [, b]) => (a.order ?? 0) - (b.order ?? 0));
  const active = main.some((m) => m.id === picked) ? picked : main[0]?.id;
  return (
    <div className="grid flex-1 grid-cols-1 gap-4 p-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
      <main>
        <div role="tablist" aria-label="Panels" className="mb-2 flex gap-2 border-b">
          {main.map(({ id, p }) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={id === active}
              className="px-3 py-1 aria-selected:border-b-2"
              onClick={() => setPicked(id)}
            >
              {p.title}
            </button>
          ))}
        </div>
        {main.map(({ id, p }) => (
          <section
            key={id}
            role="tabpanel"
            data-panel={id}
            aria-label={p.title}
            hidden={id !== active}
          >
            <Rendered contribution={p} />
          </section>
        ))}
      </main>
      <aside className="flex flex-col gap-4">
        {side.map(([id, p]) => (
          <section key={id} data-panel={id} aria-label={p.title} className="rounded border p-3">
            <h2 className="mb-2 font-semibold">{p.title}</h2>
            <Rendered contribution={p} />
          </section>
        ))}
      </aside>
    </div>
  );
}

function Dialogs() {
  const dialogs = [...useKeyedSlot(dialogsSlot)];
  return (
    <>
      {dialogs.map(([id, d], index) => (
        <FocusReturn key={id}>
          <div
            className="fixed inset-0 flex items-center justify-center bg-black/30"
            style={{ zIndex: 50 + index }}
          >
            <div
              role="dialog"
              aria-modal="true"
              aria-label={d.title}
              data-dialog={id}
              className="rounded bg-white p-4 shadow"
            >
              <h2 className="mb-2 font-semibold">{d.title}</h2>
              <Rendered contribution={d} />
            </div>
          </div>
        </FocusReturn>
      ))}
    </>
  );
}

/** Remembers the opener when a dialog appears; puts focus back when it is withdrawn. */
function FocusReturn({ children }: { children: ReactNode }) {
  const focus = useContext(FocusContext);
  useLayoutEffect(() => focus?.opened(), [focus]);
  return <>{children}</>;
}

function Toast({ item }: { item: NotificationContribution }) {
  const state = useModel(item.model.getState, item.model.onStateUpdate);
  return (
    <div
      data-notification={item.id}
      data-tone={state.tone}
      role={state.tone === "error" ? "alert" : "status"}
      className="flex items-center gap-2 rounded border bg-white px-3 py-2 shadow"
    >
      <span>{state.message}</span>
      <button type="button" aria-label="Dismiss" onClick={() => item.model.dismiss()}>
        ×
      </button>
    </div>
  );
}

function Notifications() {
  const items = useSlot(notificationsSlot);
  return (
    <div data-shell="notifications" className="fixed right-4 bottom-4 flex flex-col gap-2">
      {items.map((item) => (
        <Toast key={item.id} item={item} />
      ))}
    </div>
  );
}
