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
import { type VueRenderer, vueRenderersSlot } from "@b/shell/api/vue";
import type { KernelSlots, KeyedSlotDeclaration, SlotDeclaration } from "@kernel";
import { identityKey, modelProp, useModel } from "@kit/vue";
import { byOrder } from "@kit/slots";
import {
  type Component,
  createApp,
  defineComponent,
  Fragment,
  h,
  onBeforeUnmount,
  type PropType,
  type ShallowRef,
  ref,
} from "vue";

type Slots = Pick<KernelSlots, "observe" | "getSnapshot">;

/** A slot as a ref: the slots bus keeps the model contract, so the same binding applies. */
function useSlot<T>(slots: Slots, decl: SlotDeclaration<T>): Readonly<ShallowRef<readonly T[]>>;
function useSlot<T>(
  slots: Slots,
  decl: KeyedSlotDeclaration<T>,
): Readonly<ShallowRef<ReadonlyMap<string, T>>>;
function useSlot(
  slots: Slots,
  decl: SlotDeclaration<unknown> | KeyedSlotDeclaration<unknown>,
): Readonly<ShallowRef<unknown>> {
  const d = decl as SlotDeclaration<unknown>;
  return useModel(
    () => slots.getSnapshot(d),
    (cb) => slots.observe(d, () => cb()),
  );
}

export function mountShell(container: HTMLElement, slots: Slots): () => void {
  const app = createApp(Shell, { slots });
  app.mount(container);
  return () => app.unmount();
}

const HeaderItem = defineComponent({
  props: { item: modelProp<HeaderContribution>() },
  setup({ item }) {
    const state = useModel(item.model.getState, item.model.onStateUpdate);
    return () => h("span", { "data-header-item": item.id }, state.value.text);
  },
});

const MenuItem = defineComponent({
  props: { item: modelProp<MenuContribution>() },
  setup({ item }) {
    const state = useModel(item.action.getState, item.action.onStateUpdate);
    return () =>
      h(
        "button",
        {
          type: "button",
          role: "menuitem",
          class: "px-3 py-1 text-left disabled:opacity-50",
          disabled: !state.value.enabled || state.value.running,
          onClick: (event: MouseEvent) => {
            item.action.submit();
            (event.currentTarget as Element).closest("details")?.removeAttribute("open");
          },
        },
        state.value.label,
      );
  },
});

const Toast = defineComponent({
  props: { item: modelProp<NotificationContribution>() },
  setup({ item }) {
    const state = useModel(item.model.getState, item.model.onStateUpdate);
    return () =>
      h(
        "div",
        {
          "data-notification": item.id,
          "data-tone": state.value.tone,
          role: state.value.tone === "error" ? "alert" : "status",
          class: "flex items-center gap-2 rounded border bg-white px-3 py-2 shadow",
        },
        [
          h("span", state.value.message),
          h(
            "button",
            { type: "button", "aria-label": "Dismiss", onClick: () => item.model.dismiss() },
            "×",
          ),
        ],
      );
  },
});

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
const FocusReturn = defineComponent({
  setup(_props, { slots }) {
    const opener = document.activeElement !== document.body ? document.activeElement : lastFocused;
    onBeforeUnmount(() => {
      // After the withdrawal has rendered: the opener may have been disabled while the dialog ran.
      setTimeout(() => {
        if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
      }, 0);
    });
    return () => h(Fragment, slots.default?.());
  },
});

const Shell = defineComponent({
  props: { slots: { type: Object as PropType<Slots>, required: true } },
  setup({ slots }) {
    const renderers = useSlot(slots, vueRenderersSlot);
    const menu = useSlot(slots, menuSlot);
    const header = useSlot(slots, headerSlot);
    const panels = useSlot(slots, panelsSlot);
    const dialogs = useSlot(slots, dialogsSlot);
    const notifications = useSlot(slots, notificationsSlot);
    const picked = ref<string | undefined>();

    /** A contribution whose kind has a renderer; otherwise nothing (the coverage report lists it). */
    const rendered = (c: PanelContribution | DialogContribution) => {
      const r = renderers.value.get(c.kind.id) as VueRenderer<unknown> | undefined;
      return r
        ? h(r.component as Component, { key: identityKey(c.model as object), model: c.model })
        : null;
    };

    const menuView = () => {
      const byGroup = new Map<string, { label: string; items: MenuContribution[] }>();
      for (const item of byOrder(menu.value)) {
        const g = byGroup.get(item.group) ?? { label: item.groupLabel, items: [] };
        g.items.push(item);
        byGroup.set(item.group, g);
      }
      return h(
        "nav",
        { "aria-label": "Main menu", class: "flex gap-2" },
        [...byGroup]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([group, { label, items }]) =>
            h("details", { key: group, "data-menu-group": group, class: "relative" }, [
              h("summary", { class: "cursor-pointer px-2" }, label),
              h(
                "div",
                {
                  role: "menu",
                  "aria-label": label,
                  class: "absolute z-10 flex flex-col border bg-white",
                },
                items.map((item) => h(MenuItem, { key: identityKey(item), item })),
              ),
            ]),
          ),
      );
    };

    const panelsView = () => {
      const entries = [...panels.value];
      const main = entries
        .map(([id, p], index) => ({ id, p, index }))
        .filter(({ p }) => p.placement === "main")
        .sort((a, b) => (a.p.order ?? 0) - (b.p.order ?? 0) || a.index - b.index);
      const side = entries
        .filter(([, p]) => p.placement === "side")
        .sort(([, a], [, b]) => (a.order ?? 0) - (b.order ?? 0));
      const active = main.some((m) => m.id === picked.value) ? picked.value : main[0]?.id;
      return h(
        "div",
        { class: "grid flex-1 grid-cols-1 gap-4 p-4 lg:grid-cols-[minmax(0,1fr)_22rem]" },
        [
          h("main", [
            h(
              "div",
              { role: "tablist", "aria-label": "Panels", class: "mb-2 flex gap-2 border-b" },
              main.map(({ id, p }) =>
                h(
                  "button",
                  {
                    key: id,
                    type: "button",
                    role: "tab",
                    "aria-selected": String(id === active),
                    class: "px-3 py-1 aria-selected:border-b-2",
                    onClick: () => {
                      picked.value = id;
                    },
                  },
                  p.title,
                ),
              ),
            ),
            ...main.map(({ id, p }) =>
              h(
                "section",
                {
                  key: id,
                  role: "tabpanel",
                  "data-panel": id,
                  "aria-label": p.title,
                  hidden: id !== active,
                },
                [rendered(p)],
              ),
            ),
          ]),
          h(
            "aside",
            { class: "flex flex-col gap-4" },
            side.map(([id, p]) =>
              h(
                "section",
                { key: id, "data-panel": id, "aria-label": p.title, class: "rounded border p-3" },
                [h("h2", { class: "mb-2 font-semibold" }, p.title), rendered(p)],
              ),
            ),
          ),
        ],
      );
    };

    const dialogsView = () =>
      [...dialogs.value].map(([id, d], index) =>
        h(FocusReturn, { key: id }, () =>
          h(
            "div",
            {
              class: "fixed inset-0 flex items-center justify-center bg-black/30",
              style: { zIndex: 50 + index },
            },
            h(
              "div",
              {
                role: "dialog",
                "aria-modal": "true",
                "aria-label": d.title,
                "data-dialog": id,
                class: "rounded bg-white p-4 shadow",
              },
              [h("h2", { class: "mb-2 font-semibold" }, d.title), rendered(d)],
            ),
          ),
        ),
      );

    return () =>
      h("div", { class: "flex min-h-screen flex-col" }, [
        h("div", { class: "flex items-center gap-4 border-b px-4 py-2" }, [
          menuView(),
          h(
            "header",
            { "data-shell": "header", class: "ml-auto flex gap-4 text-sm" },
            byOrder(header.value).map((item) => h(HeaderItem, { key: identityKey(item), item })),
          ),
        ]),
        panelsView(),
        ...dialogsView(),
        h(
          "div",
          { "data-shell": "notifications", class: "fixed right-4 bottom-4 flex flex-col gap-2" },
          notifications.value.map((item) => h(Toast, { key: identityKey(item), item })),
        ),
      ]);
  },
});
