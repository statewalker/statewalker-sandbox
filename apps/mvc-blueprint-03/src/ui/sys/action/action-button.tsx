import { Button } from "@statewalker/ui.view.shadcn";
import type { ActionView } from "@sys/action/model";
import { useModel } from "@ui/host";
import type { ComponentProps } from "react";

export interface ActionButtonProps {
  readonly action: ActionView;
  readonly variant?: ComponentProps<typeof Button>["variant"];
  readonly size?: ComponentProps<typeof Button>["size"];
  readonly className?: string;
  readonly ariaLabel?: string;
}

/** Any action as a button: its label, icon and hint; disabled while not enabled or running. */
export function ActionButton({ action, variant, size, className, ariaLabel }: ActionButtonProps) {
  const state = useModel(action.getState, action.onStateUpdate);
  return (
    <Button
      type="button"
      variant={variant}
      size={size}
      className={className}
      aria-label={ariaLabel}
      aria-busy={state.running}
      data-icon={state.icon}
      title={state.hint}
      disabled={!state.enabled || state.running}
      onClick={() => action.submit()}
    >
      {state.label}
    </Button>
  );
}
