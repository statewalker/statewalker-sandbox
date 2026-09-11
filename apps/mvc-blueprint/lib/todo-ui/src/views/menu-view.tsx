import { Button } from "@statewalker/ui.view.shadcn";
import type { MenuModel } from "@todo/app/models";
import { useEffect } from "react";
import { useSettleOnce } from "./use-settle-once.js";

/**
 * `ui:show-menu` — a positioned list of `Button`s (the kit has no dropdown
 * menu). Its items are the MODEL's, which the controller copied from the
 * declarations (spec §4.4); the view never reads the registry. Choosing an
 * item settles `{ selectedKey }`; Escape settles `{}` — nothing chosen.
 *
 * `icon` is carried as `data-icon` rather than drawn: it names a lucide glyph,
 * and this package takes no icon dependency until a view draws one.
 */
export function MenuView({
  model,
  settle,
}: {
  model: MenuModel;
  settle: (result: { selectedKey?: string }) => void;
}) {
  const answer = useSettleOnce(settle);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") answer({});
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [answer]);

  return (
    <div
      role="menu"
      className="fixed top-1/3 left-1/2 z-50 flex min-w-48 -translate-x-1/2 flex-col gap-1 rounded-md border bg-popover p-1 text-popover-foreground shadow-md"
    >
      {model.items.map((item, index) => (
        <Button
          key={item.key}
          role="menuitem"
          variant="ghost"
          className="justify-start"
          data-icon={item.icon}
          autoFocus={index === 0}
          onClick={() => answer({ selectedKey: item.key })}
        >
          {item.label ?? item.key}
        </Button>
      ))}
    </div>
  );
}
