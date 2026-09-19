import {
  type DialogContribution,
  dialogsSlot,
  headerSlot,
  type MenuContribution,
  menuSlot,
  notificationsSlot,
  type PanelContribution,
  panelsSlot,
} from "@b/shell/api";
import { type DomRenderer, domRenderersSlot } from "@b/shell/api/dom";
import type { KernelSlots } from "@kernel";
import { bind, h, newScope } from "@kit/dom";
import { byOrder } from "@kit/slots";

type Slots = Pick<KernelSlots, "observe" | "getSnapshot">;

interface Mounted {
  readonly contribution: PanelContribution | DialogContribution;
  readonly el: HTMLElement;
  readonly body: HTMLElement;
  unmount?: () => void;
  mountedWith?: DomRenderer<unknown>;
}

let lastFocused: Element | null = null;
document.addEventListener("focusin", (event) => {
  if (!(event.target as Element).closest?.('[role="dialog"]'))
    lastFocused = event.target as Element;
});

/** Mounts or unmounts `m`'s view to match the renderer currently registered for its kind. */
function sync(m: Mounted, renderers: ReadonlyMap<string, DomRenderer<never>>): void {
  const renderer = renderers.get(m.contribution.kind.id) as DomRenderer<unknown> | undefined;
  if (renderer === m.mountedWith) return;
  m.unmount?.();
  m.unmount = undefined;
  m.body.replaceChildren();
  m.mountedWith = renderer;
  if (renderer) m.unmount = renderer.mount(m.body, m.contribution.model);
}

function unmount(m: Mounted): void {
  m.unmount?.();
  m.el.remove();
}

/** The DOM shell host: the same markup contract as the React host, with no framework. */
export function mountShell(container: HTMLElement, slots: Slots): () => void {
  const scope = newScope();
  const menu = h("nav", { "aria-label": "Main menu", class: "flex gap-2" });
  const header = h("header", { "data-shell": "header", class: "ml-auto flex gap-4 text-sm" });
  const tablist = h("div", {
    role: "tablist",
    "aria-label": "Panels",
    class: "mb-2 flex gap-2 border-b",
  });
  const main = h("main", {}, tablist);
  const side = h("aside", { class: "flex flex-col gap-4" });
  const dialogs = h("div");
  const toasts = h("div", {
    "data-shell": "notifications",
    class: "fixed right-4 bottom-4 flex flex-col gap-2",
  });
  container.append(
    h("div", { class: "flex items-center gap-4 border-b px-4 py-2" }, menu, header),
    h(
      "div",
      { class: "grid flex-1 grid-cols-1 gap-4 p-4 lg:grid-cols-[minmax(0,1fr)_22rem]" },
      main,
      side,
    ),
    dialogs,
    toasts,
  );

  // ── header ────────────────────────────────────────────────────────────────────────────────
  const headerScope = newScope();
  scope.own(headerScope.dispose);
  scope.own(
    slots.observe(headerSlot, (items) => {
      headerScope.dispose();
      header.replaceChildren(
        ...byOrder(items).map((item) => {
          const span = h("span", { "data-header-item": item.id });
          headerScope.own(
            bind(item.model.getState, item.model.onStateUpdate, (s) => (span.textContent = s.text)),
          );
          return span;
        }),
      );
    }),
  );

  // ── main menu ─────────────────────────────────────────────────────────────────────────────
  const menuScope = newScope();
  scope.own(menuScope.dispose);
  scope.own(
    slots.observe(menuSlot, (items) => {
      menuScope.dispose();
      const groups = new Map<string, { label: string; items: MenuContribution[] }>();
      for (const item of byOrder(items)) {
        const g = groups.get(item.group) ?? { label: item.groupLabel, items: [] };
        g.items.push(item);
        groups.set(item.group, g);
      }
      menu.replaceChildren(
        ...[...groups]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([group, g]) => {
            const details = h("details", { "data-menu-group": group, class: "relative" });
            const list = h("div", {
              role: "menu",
              "aria-label": g.label,
              class: "absolute z-10 flex flex-col border bg-white",
            });
            for (const item of g.items) {
              const button = h("button", {
                type: "button",
                role: "menuitem",
                class: "px-3 py-1 text-left disabled:opacity-50",
                onclick: () => {
                  item.action.submit();
                  details.removeAttribute("open");
                },
              });
              menuScope.own(
                bind(item.action.getState, item.action.onStateUpdate, (s) => {
                  button.textContent = s.label;
                  button.disabled = !s.enabled || s.running;
                }),
              );
              list.append(button);
            }
            details.append(h("summary", { class: "cursor-pointer px-2" }, g.label), list);
            return details;
          }),
      );
    }),
  );

  // ── panels and dialogs: paired with renderers, in any arrival order ─────────────────────────
  let renderers: ReadonlyMap<string, DomRenderer<never>> = new Map();
  const panels = new Map<string, Mounted>();
  const shownDialogs = new Map<string, Mounted & { opener: Element | null }>();
  let picked: string | undefined;

  const layoutPanels = () => {
    const snapshot = slots.getSnapshot(panelsSlot);
    for (const [id, m] of panels) {
      if (snapshot.get(id) !== m.contribution) {
        unmount(m);
        panels.delete(id);
      }
    }
    for (const [id, p] of snapshot) {
      if (panels.has(id)) continue;
      const body = h("div");
      const el =
        p.placement === "main"
          ? h("section", { role: "tabpanel", "data-panel": id, "aria-label": p.title }, body)
          : h(
              "section",
              { "data-panel": id, "aria-label": p.title, class: "rounded border p-3" },
              h("h2", { class: "mb-2 font-semibold" }, p.title),
              body,
            );
      panels.set(id, { contribution: p, el, body });
    }
    const entries = [...snapshot].map(([id, p], index) => ({ id, p, index }));
    const mains = entries
      .filter(({ p }) => p.placement === "main")
      .sort((a, b) => (a.p.order ?? 0) - (b.p.order ?? 0) || a.index - b.index);
    const sides = entries
      .filter(({ p }) => p.placement === "side")
      .sort((a, b) => (a.p.order ?? 0) - (b.p.order ?? 0) || a.index - b.index);
    const active = mains.some((m) => m.id === picked) ? picked : mains[0]?.id;
    tablist.replaceChildren(
      ...mains.map(({ id, p }) =>
        h(
          "button",
          {
            type: "button",
            role: "tab",
            "aria-selected": String(id === active),
            class: "px-3 py-1 aria-selected:border-b-2",
            onclick: () => {
              picked = id;
              layoutPanels();
            },
          },
          p.title,
        ),
      ),
    );
    for (const { id } of mains) {
      const m = panels.get(id) as Mounted;
      m.el.hidden = id !== active;
      main.append(m.el);
    }
    for (const { id } of sides) side.append((panels.get(id) as Mounted).el);
    for (const m of panels.values()) sync(m, renderers);
  };

  const layoutDialogs = () => {
    const snapshot = slots.getSnapshot(dialogsSlot);
    for (const [id, m] of shownDialogs) {
      if (snapshot.get(id) === m.contribution) continue;
      unmount(m);
      shownDialogs.delete(id);
      const back = m.opener;
      setTimeout(() => {
        if (back instanceof HTMLElement && back.isConnected) back.focus();
      }, 0);
    }
    let z = 50;
    for (const [id, d] of snapshot) {
      let m = shownDialogs.get(id);
      if (!m) {
        const body = h("div");
        const box = h(
          "div",
          {
            role: "dialog",
            "aria-modal": "true",
            "aria-label": d.title,
            "data-dialog": id,
            class: "rounded bg-white p-4 shadow",
          },
          h("h2", { class: "mb-2 font-semibold" }, d.title),
          body,
        );
        const el = h(
          "div",
          { class: "fixed inset-0 flex items-center justify-center bg-black/30" },
          box,
        );
        const opener =
          document.activeElement !== document.body ? document.activeElement : lastFocused;
        m = { contribution: d, el, body, opener };
        shownDialogs.set(id, m);
        dialogs.append(el);
      }
      m.el.style.zIndex = String(z++);
      sync(m, renderers);
    }
  };

  scope.own(
    slots.observe(domRenderersSlot, (next) => {
      renderers = next;
      layoutPanels();
      layoutDialogs();
    }),
  );
  scope.own(slots.observe(panelsSlot, layoutPanels));
  scope.own(slots.observe(dialogsSlot, layoutDialogs));
  scope.own(() => {
    for (const m of [...panels.values(), ...shownDialogs.values()]) unmount(m);
    panels.clear();
    shownDialogs.clear();
  });

  // ── notifications ─────────────────────────────────────────────────────────────────────────
  const toastScope = newScope();
  scope.own(toastScope.dispose);
  scope.own(
    slots.observe(notificationsSlot, (items) => {
      toastScope.dispose();
      toasts.replaceChildren(
        ...items.map((item) => {
          const text = h("span");
          const el = h(
            "div",
            {
              "data-notification": item.id,
              class: "flex items-center gap-2 rounded border bg-white px-3 py-2 shadow",
            },
            text,
            h(
              "button",
              { type: "button", "aria-label": "Dismiss", onclick: () => item.model.dismiss() },
              "×",
            ),
          );
          toastScope.own(
            bind(item.model.getState, item.model.onStateUpdate, (s) => {
              text.textContent = s.message;
              el.dataset.tone = s.tone;
              el.setAttribute("role", s.tone === "error" ? "alert" : "status");
            }),
          );
          return el;
        }),
      );
    }),
  );

  return () => {
    scope.dispose();
    container.replaceChildren();
  };
}
