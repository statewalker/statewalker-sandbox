import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@statewalker/ui.view.shadcn";
import type { ConfirmView } from "@todos/clear-completed/model";
import { ActionButton } from "@ui/sys/action";

/** Open from the first frame; it leaves when the controller withdraws it. The answers are actions. */
export function ClearCompletedConfirm({ model }: { model: ConfirmView }) {
  const question = model.getQuestion();
  return (
    <AlertDialog open>
      <AlertDialogContent onEscapeKeyDown={() => model.actions.cancel.submit()}>
        <AlertDialogHeader>
          <AlertDialogTitle>Clear completed</AlertDialogTitle>
          <AlertDialogDescription>{question.text}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <ActionButton action={model.actions.cancel} variant="outline" />
          <ActionButton action={model.actions.ok} variant="destructive" />
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
