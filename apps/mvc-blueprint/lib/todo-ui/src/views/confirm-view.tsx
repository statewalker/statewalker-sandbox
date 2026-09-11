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
import { useSettleOnce } from "./use-settle-once.js";

/**
 * `ui:show-dialog:confirm`. Open from the first frame and never closed by
 * itself: the dialog leaves the screen when its command settles, which is the
 * adapter's job. Every way out — Confirm, Cancel, Escape — is an answer.
 */
export function ConfirmView({
  model,
  settle,
}: {
  model: ConfirmModel;
  settle: (result: { confirmed: boolean }) => void;
}) {
  const answer = useSettleOnce(settle);
  return (
    <AlertDialog open onOpenChange={(open) => !open && answer({ confirmed: false })}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Please confirm</AlertDialogTitle>
          <AlertDialogDescription>{model.question}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={() => answer({ confirmed: true })}>Confirm</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
