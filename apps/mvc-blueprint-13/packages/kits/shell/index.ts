import type {
  KeyedSlotDeclaration,
  Listener,
  SlotDeclaration,
  Unsubscribe,
  ViewKind,
} from "@p5/kernel";
import { newChannels, stableGroup } from "@p5/kit-model";
import { byOrder } from "@p5/kit-slots";
import { batch, signal, untracked } from "@p5/kit-signals";
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

/**
 * OPTIONAL kit (D15, F7): the technology-neutral SHELL-HOST MODEL. Everything a shell host used to
 * compute per technology — menu groups, header order, main/side panels and the active tab, the
 * dialog stack, toasts, and which renderer draws a contribution — is one presentation model under
 * the model contract. A technology's host is then a renderer of this model (plus the DOM-only
 * focus rule, `@p5/kit-host`).
 */
export interface MenuGroup {
  readonly group: string;
  readonly label: string;
  readonly items: readonly MenuContribution[];
}

/** A contribution paired with its renderer — the existential cast lives here, once. */
export interface Rendered<C> {
  readonly id: string;
  readonly contribution: PanelContribution | DialogContribution;
  /** The renderer's own component (or whatever a technology registers), for this contribution's kind. */
  readonly component: C | undefined;
}

export interface ShellHostView<C> {
  getMenu(): readonly MenuGroup[];
  onMenuUpdate(listener: Listener): Unsubscribe;
  getHeader(): readonly HeaderContribution[];
  onHeaderUpdate(listener: Listener): Unsubscribe;
  getMain(): readonly Rendered<C>[];
  onMainUpdate(listener: Listener): Unsubscribe;
  getSide(): readonly Rendered<C>[];
  onSideUpdate(listener: Listener): Unsubscribe;
  /** Input: the picked tab; falls back to the first main panel when it goes. */
  getActiveTab(): string | undefined;
  onActiveTabUpdate(listener: Listener): Unsubscribe;
  selectTab(id: string): void;
  /** Oldest first: the last is on top. */
  getDialogs(): readonly Rendered<C>[];
  onDialogsUpdate(listener: Listener): Unsubscribe;
  getNotifications(): readonly NotificationContribution[];
  onNotificationsUpdate(listener: Listener): Unsubscribe;
}

type Slots = {
  observe<T>(decl: SlotDeclaration<T>, cb: (values: readonly T[]) => void): () => void;
  observe<T>(
    decl: KeyedSlotDeclaration<T>,
    cb: (entries: ReadonlyMap<string, T>) => void,
  ): () => void;
};

export function createShellHostModel<C>(
  slots: Slots,
  renderers: KeyedSlotDeclaration<{ readonly kind: ViewKind<unknown>; readonly component: C }>,
): { readonly view: ShellHostView<C>; dispose(): void } {
  let disposed = false;
  const channels = newChannels(() => disposed);
  const plain = <T>(decl: SlotDeclaration<T>) => {
    const s = signal<readonly T[]>([]);
    return [s, slots.observe(decl, (v) => s(v))] as const;
  };
  const keyed = <T>(decl: KeyedSlotDeclaration<T>) => {
    const s = signal<ReadonlyMap<string, T>>(new Map<string, T>());
    return [s, slots.observe(decl, (v) => s(v))] as const;
  };
  const [menu, offMenu] = plain(menuSlot);
  const [header, offHeader] = plain(headerSlot);
  const [notifications, offToasts] = plain(notificationsSlot);
  const [panels, offPanels] = keyed(panelsSlot);
  const [dialogs, offDialogs] = keyed(dialogsSlot);
  const [kinds, offKinds] = keyed(renderers);
  const picked = signal<string | undefined>(undefined);

  /** Stable per entry: a new object only when the contribution or its renderer changes. */
  const cache = new WeakMap<object, Rendered<C>>();
  const rendered = (id: string, c: PanelContribution | DialogContribution): Rendered<C> => {
    const component = kinds().get(c.kind.id)?.component;
    const hit = cache.get(c);
    if (hit && hit.id === id && hit.component === component) return hit;
    const next = Object.freeze({ id, contribution: c, component });
    cache.set(c, next);
    return next;
  };
  const placed = (placement: "main" | "side") =>
    stableGroup(() =>
      Object.freeze(
        [...panels()]
          .map(([id, p], index) => ({ id, p, index }))
          .filter(({ p }) => p.placement === placement)
          .sort((a, b) => (a.p.order ?? 0) - (b.p.order ?? 0) || a.index - b.index)
          .map(({ id, p }) => rendered(id, p)),
      ),
    );
  const main = placed("main");
  const side = placed("side");
  const groups = stableGroup((): readonly MenuGroup[] => {
    const byGroup = new Map<string, { label: string; items: MenuContribution[] }>();
    for (const item of byOrder(menu())) {
      const g = byGroup.get(item.group) ?? { label: item.groupLabel, items: [] };
      g.items.push(item);
      byGroup.set(item.group, g);
    }
    return Object.freeze(
      [...byGroup]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([group, g]) =>
          Object.freeze({ group, label: g.label, items: Object.freeze(g.items) }),
        ),
    );
  });
  const headerItems = stableGroup(() => Object.freeze(byOrder(header())));
  const active = stableGroup(() => {
    const ids = main().map((r) => r.id);
    const p = picked();
    return p !== undefined && ids.includes(p) ? p : ids[0];
  });
  const stack = stableGroup(() => Object.freeze([...dialogs()].map(([id, d]) => rendered(id, d))));
  const toasts = stableGroup((): readonly NotificationContribution[] =>
    Object.freeze([...notifications()]),
  );

  const view: ShellHostView<C> = Object.freeze({
    getMenu: () => groups(),
    onMenuUpdate: channels.channel(groups),
    getHeader: () => headerItems(),
    onHeaderUpdate: channels.channel(headerItems),
    getMain: () => main(),
    onMainUpdate: channels.channel(main),
    getSide: () => side(),
    onSideUpdate: channels.channel(side),
    getActiveTab: () => active(),
    onActiveTabUpdate: channels.channel(active),
    selectTab: (id: string) => {
      if (!disposed && untracked(() => picked()) !== id) batch(() => picked(id));
    },
    getDialogs: () => stack(),
    onDialogsUpdate: channels.channel(stack),
    getNotifications: () => toasts(),
    onNotificationsUpdate: channels.channel(toasts),
  });
  return Object.freeze({
    view,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      for (const off of [offMenu, offHeader, offToasts, offPanels, offDialogs, offKinds]) off();
      channels.dispose();
    },
  });
}
