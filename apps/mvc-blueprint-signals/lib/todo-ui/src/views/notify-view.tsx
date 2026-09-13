import { Card, CardContent } from "@statewalker/ui.view.shadcn";
import type { NotifyModel } from "@todo/app/models";
import { useEffect } from "react";

/** How long a toast stays up when the host does not say. */
export const NOTIFY_TIMEOUT_MS = 4000;

/**
 * `ui:notify` — a small `Card` toast (the kit ships none) that settles its
 * own command once `timeoutMs` elapses; the settle is what unmounts it. The
 * timeout is a prop so a host — or a suite — can choose it. Unmounted early
 * (the view layer disposed), it settles nothing.
 */
export function NotifyView({
  model,
  settle,
  timeoutMs = NOTIFY_TIMEOUT_MS,
}: {
  model: NotifyModel;
  settle: () => void;
  timeoutMs?: number;
}) {
  useEffect(() => {
    const timer = setTimeout(() => settle(), timeoutMs);
    return () => clearTimeout(timer);
  }, [settle, timeoutMs]);

  return (
    <Card role="status" aria-live="polite" className="fixed right-4 bottom-4 z-50 w-80">
      <CardContent className="p-4 text-sm">{model.text}</CardContent>
    </Card>
  );
}
