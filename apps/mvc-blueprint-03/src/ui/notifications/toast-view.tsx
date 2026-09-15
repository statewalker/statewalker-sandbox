import { Button, Card, CardContent, cn } from "@statewalker/ui.view.shadcn";
import type { NotificationView } from "@notifications/model";

/** One message. Errors are announced assertively; everything else politely. */
export function NotificationToast({ model }: { model: NotificationView }) {
  const message = model.getMessage();
  const error = message.level === "error";
  return (
    <Card
      role={error ? "alert" : "status"}
      data-level={message.level}
      className={cn("w-80 shadow-md", error && "border-destructive")}
    >
      <CardContent className="flex items-start gap-3 p-4 text-sm">
        <span className={cn("flex-1", error && "text-destructive")}>{message.text}</span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label="Dismiss"
          onClick={() => model.dismiss()}
        >
          ×
        </Button>
      </CardContent>
    </Card>
  );
}
