/** A headless "user": reads what a host would render (points) and does what a view would (dispatch). */
import type { ActionItem, Store } from "../../src/kernel/index.ts";
import {
  type Dialog,
  type MenuItem,
  type Panel,
  shellDialogs,
  shellHeader,
  shellMenu,
  shellNotifications,
  shellPanels,
} from "../../src/bundles/shell/api/index.ts";

export const user = (store: Store) => {
  const panel = <P>(id: string) =>
    store.select(shellPanels).find((p) => p.id === id) as Panel<P> | undefined;
  const dialog = <P>(id: string) =>
    store.select(shellDialogs).find((d) => d.id === id) as Dialog<P> | undefined;
  /** Like a button: a disabled item does nothing. Returns whether it fired. */
  const press = (item: ActionItem | undefined): boolean => {
    if (!item) throw new Error("press: no such action");
    if (!item.enabled) return false;
    store.dispatch(item.msg);
    return true;
  };
  return {
    panel,
    dialog,
    press,
    panelIds: () => store.select(shellPanels).map((p) => p.id),
    header: () => store.select(shellHeader).map((h) => h.text),
    menu: () => store.select(shellMenu) as readonly MenuItem[],
    menuItem: (label: string) => store.select(shellMenu).find((m) => m.label === label),
    toasts: () => store.select(shellNotifications).map((n) => `${n.tone}:${n.message}`),
    action: (items: readonly ActionItem[] | undefined, label: string) =>
      items?.find((a) => a.label === label),
  };
};
