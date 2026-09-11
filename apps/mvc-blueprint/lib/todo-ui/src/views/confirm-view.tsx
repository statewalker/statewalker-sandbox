import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@statewalker/ui.view.shadcn";
import type { ConfirmModel } from "@todo/app/models";

/**
 * `ui:show-dialog:confirm`. Open from the first frame and never closed by
 * itself: the dialog leaves the screen when its command settles, which is the
 * adapter's job. Every way out — Confirm, Cancel, Escape — answers once.
 *
 * Each answer is settled EXPLICITLY, where it happens. The dialog is
 * controlled (`open`, no `onOpenChange`), so Radix's own close — which it
 * fires after an Action's `onClick` — changes nothing and answers nothing.
 * Deriving "cancelled" from `onOpenChange(false)` instead would make Confirm
 * answer yes and then no. An alert dialog ignores outside clicks, so these
 * three are the only ways out.
 */
export function ConfirmView({
  model,
  settle,
}: {
  model: ConfirmModel;
  settle: (result: { confirmed: boolean }) => void;
}) {
  return (
    <AlertDialog open>
      <AlertDialogContent onEscapeKeyDown={() => settle({ confirmed: false })}>
        <AlertDialogHeader>
          <AlertDialogTitle>Please confirm</AlertDialogTitle>
          <AlertDialogDescription>{model.question}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={() => settle({ confirmed: false })}>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={() => settle({ confirmed: true })}>Confirm</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
