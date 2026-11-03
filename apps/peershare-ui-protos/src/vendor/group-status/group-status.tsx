import {
  Button,
  cn,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@statewalker/ui.view.shadcn";
import { RefreshCw } from "lucide-react";
import { group } from "../mock.js";

/** The encrypted link between this browser and the group's Sandclaw machine. */
export type LinkState = "connected" | "connecting" | "offline";

const words: Record<LinkState, string> = {
  connected: "connected",
  connecting: "connecting…",
  offline: "offline",
};

const dot: Record<LinkState, string> = {
  connected: "bg-success",
  connecting: "bg-warning animate-pulse",
  offline: "bg-destructive",
};

const details: Record<LinkState, string> = {
  connected: "Connected to the Sandclaw machine · end-to-end encrypted",
  connecting: "Reaching the Sandclaw machine…",
  offline: `The Sandclaw machine isn't answering. Ask ${group.admin} to check it's switched on.`,
};

/** "Atelier Morel · connected": the group's name and the link's state, details on hover. */
export function GroupPill({ state, onClick }: { state: LinkState; onClick?: () => void }) {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={onClick}
            className="bg-secondary flex items-center gap-2 rounded-full px-3 py-1 text-xs"
          >
            <span className={cn("size-2 rounded-full", dot[state])} />
            {group.name} · {words[state]}
          </button>
        </TooltipTrigger>
        <TooltipContent>{details[state]}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

/**
 * How the group's state is shown:
 * - `pill`: the pill alone; the explanation is in its tooltip;
 * - `pill-banner`: the pill, plus a banner under the top bar while offline.
 */
export type StatusVariant = "pill" | "pill-banner";

export function GroupStatus({ state, variant }: { state: LinkState; variant: StatusVariant }) {
  return (
    <div>
      <div className="flex h-12 items-center border-b px-4">
        <GroupPill state={state} />
      </div>
      {variant === "pill-banner" && state === "offline" && (
        <div className="flex items-center gap-3 border-b px-4 py-2 text-sm">
          <span className="flex-1">
            The Sandclaw machine isn&apos;t answering. Your chats and files are safe in this
            browser; new questions will wait. Ask {group.admin} to check it&apos;s switched on.
          </span>
          <Button size="sm" variant="outline">
            <RefreshCw /> Retry
          </Button>
        </div>
      )}
    </div>
  );
}
