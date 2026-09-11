import { Button } from "@statewalker/ui.view.shadcn";
import type { MenuModel } from "@todo/app/models";

/**
 * `ui:show-menu` — a positioned list of `Button`s (the kit has no dropdown
 * menu). Its items are the MODEL's, which the controller copied from the
 * declarations (spec §4.4); the view never reads the registry. Choosing an
 * item settles `{ selectedKey }`; Escape settles `{}` — nothing chosen.
 *
 * Escape is heard on the MENU, not on `document`: a document listener would
 * let one keypress answer every open menu and dialog at once. The first item
 * takes focus on mount, so the key reaches the menu without a click.
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
  return (
    <div
      role="menu"
      className="fixed top-1/3 left-1/2 z-50 flex min-w-48 -translate-x-1/2 flex-col gap-1 rounded-md border bg-popover p-1 text-popover-foreground shadow-md"
      onKeyDown={(event) => {
        if (event.key === "Escape") settle({});
      }}
    >
      {model.items.map((item, index) => (
        <Button
          key={item.key}
          role="menuitem"
          variant="ghost"
          className="justify-start"
          data-icon={item.icon}
          autoFocus={index === 0}
          onClick={() => settle({ selectedKey: item.key })}
        >
          {item.label ?? item.key}
        </Button>
      ))}
    </div>
  );
}
