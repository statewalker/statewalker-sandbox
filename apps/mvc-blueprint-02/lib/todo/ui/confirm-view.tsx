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
import type { ConfirmDialogView } from "@todo/models";

/**
 * Open from the first frame; it leaves the screen when the controller withdraws
 * its `ui:dialogs` contribution, never by itself. Every way out answers once.
 */
export function ConfirmView({ model }: { model: ConfirmDialogView }) {
  return (
    <AlertDialog open>
      <AlertDialogContent onEscapeKeyDown={() => model.answer(false)}>
        <AlertDialogHeader>
          <AlertDialogTitle>Please confirm</AlertDialogTitle>
          <AlertDialogDescription>{model.getQuestion()}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={() => model.answer(false)}>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={() => model.answer(true)}>Confirm</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
