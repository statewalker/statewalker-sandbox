import { Button } from "@statewalker/ui.view.shadcn";
import type { ActionView } from "@sys/action/model";
import { type ActionContribution, type SlotDeclaration, sortActions } from "@sys/extension-points";
import { useModel, useSlot } from "@ui/host";
import { useEffect, useMemo, useRef } from "react";

export interface ActionMenuProps {
  readonly slot: SlotDeclaration<ActionContribution>;
  readonly label: string;
  readonly position: { readonly x: number; readonly y: number };
  readonly onClose: () => void;
}

/** Every action contributed to `slot`, as a positioned menu. The kit has no dropdown; a list of buttons. */
export function ActionMenu({ slot, label, position, onClose }: ActionMenuProps) {
  const items = useSlot(slot);
  const sorted = useMemo(() => sortActions(items), [items]);
  const menu = useRef<HTMLDivElement>(null);
  useEffect(() => {
    menu.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  }, []);
  return (
    <>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: a click-away backdrop; Escape on the menu is the keyboard path */}
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: as above */}
      <div
        aria-hidden="true"
        className="fixed inset-0 z-40"
        onClick={onClose}
        onContextMenu={(event) => {
          event.preventDefault();
          onClose();
        }}
      />
      <div
        ref={menu}
        role="menu"
        aria-label={label}
        className="fixed z-50 flex min-w-44 flex-col gap-1 rounded-md border bg-popover p-1 text-popover-foreground shadow-md"
        style={{ left: position.x, top: position.y }}
        onKeyDown={(event) => {
          if (event.key === "Escape") onClose();
        }}
      >
        {sorted.map((c) => (
          <MenuItem key={c.id} action={c.action} onChosen={onClose} />
        ))}
      </div>
    </>
  );
}

function MenuItem({ action, onChosen }: { action: ActionView; onChosen: () => void }) {
  const state = useModel(action.getState, action.onStateUpdate);
  return (
    <Button
      type="button"
      role="menuitem"
      variant="ghost"
      className="justify-start"
      data-icon={state.icon}
      title={state.hint}
      disabled={!state.enabled || state.running}
      onClick={() => {
        action.submit();
        onChosen();
      }}
    >
      {state.label}
    </Button>
  );
}
