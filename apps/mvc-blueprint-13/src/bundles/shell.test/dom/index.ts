import {
  dialogsSlot,
  headerSlot,
  menuSlot,
  notificationsSlot,
  panelsSlot,
  shellCoverage,
  shellRoot,
} from "@b/shell/api";
import { type DomRenderer, domRenderersSlot } from "@b/shell/api/dom";
import { type Controller, getSlots, useFields } from "@kernel";
import { createCoverage } from "@kit/host";

const fields = useFields({ slots: getSlots, root: shellRoot.get });

/**
 * The trivial test shell, DOM variant: the least code that renders the shell API. Everything is
 * re-rendered from scratch on any change; panels are stacked (no tabs); no styling, no focus care.
 */
export const activate: Controller = async (context) => {
  const { slots, root } = fields(context);
  const coverage = createCoverage(slots, domRenderersSlot);
  shellCoverage.set(context, coverage);
  const container = document.createElement("div");
  container.dataset.shell = "test";
  root.append(container);
  let unmounts: (() => void)[] = [];
  const el = (tag: string, attrs: Record<string, string> = {}, text = "") => {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    e.textContent = text;
    return e;
  };
  const render = () => {
    for (const u of unmounts) u();
    unmounts = [];
    container.replaceChildren();
    const renderers = slots.getSnapshot(domRenderersSlot);
    const nav = el("nav", { "aria-label": "Main menu" });
    const groups = new Map<string, HTMLElement>();
    for (const item of slots.getSnapshot(menuSlot)) {
      let menu = groups.get(item.group);
      if (!menu) {
        const details = el("details", { "data-menu-group": item.group });
        details.append(el("summary", {}, item.groupLabel));
        menu = el("div", { role: "menu" });
        details.append(menu);
        nav.append(details);
        groups.set(item.group, menu);
      }
      const s = item.action.getState();
      const b = el("button", { type: "button", role: "menuitem" }, s.label) as HTMLButtonElement;
      b.disabled = !s.enabled || s.running;
      b.onclick = () => item.action.submit();
      menu.append(b);
    }
    container.append(nav);
    for (const h of slots.getSnapshot(headerSlot)) {
      container.append(el("span", { "data-header-item": h.id }, h.model.getState().text));
    }
    const mount = (attrs: Record<string, string>, c: { kind: { id: string }; model: unknown }) => {
      const host = el("section", attrs);
      container.append(host);
      const r = renderers.get(c.kind.id) as DomRenderer<unknown> | undefined;
      if (r) unmounts.push(r.mount(host, c.model));
    };
    for (const [id, p] of slots.getSnapshot(panelsSlot))
      mount({ "data-panel": id, "aria-label": p.title }, p);
    for (const [id, d] of slots.getSnapshot(dialogsSlot))
      mount({ role: "dialog", "data-dialog": id }, d);
    for (const n of slots.getSnapshot(notificationsSlot)) {
      const s = n.model.getState();
      const t = el("div", {
        "data-notification": n.id,
        role: s.tone === "error" ? "alert" : "status",
      });
      t.append(el("span", {}, s.message));
      container.append(t);
    }
  };
  // Re-render (coalesced) on any slot change and on any header/menu state change.
  let scheduled = false;
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      render();
    });
  };
  const offs = [
    slots.observe(headerSlot, schedule),
    slots.observe(menuSlot, schedule),
    slots.observe(notificationsSlot, schedule),
    slots.observe(panelsSlot, schedule),
    slots.observe(dialogsSlot, schedule),
    slots.observe(domRenderersSlot, schedule),
  ];
  const stateOffs: (() => void)[] = [];
  const watchStates = () => {
    for (const off of stateOffs.splice(0)) off();
    for (const h of slots.getSnapshot(headerSlot)) stateOffs.push(h.model.onStateUpdate(schedule));
    for (const m of slots.getSnapshot(menuSlot)) stateOffs.push(m.action.onStateUpdate(schedule));
  };
  offs.push(slots.observe(headerSlot, watchStates), slots.observe(menuSlot, watchStates));
  render();
  return () => {
    for (const off of [...offs, ...stateOffs]) off();
    for (const u of unmounts) u();
    container.remove();
    coverage.dispose();
  };
};
