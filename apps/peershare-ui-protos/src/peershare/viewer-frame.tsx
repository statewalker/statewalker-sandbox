import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
  Button,
  cn,
} from "@statewalker/ui.view.shadcn";
import { PauseCircle } from "lucide-react";
import type { ReactNode } from "react";
import type { LinkState } from "../vendor/group-status/group-status.js";
import { Choice } from "../vendor/team/team.js";

export interface ViewerService {
  id: string;
  name: string;
  paused: boolean;
}

export interface ViewerFrameProps {
  sharerName: string;
  services: ViewerService[];
  selected: string;
  link: LinkState;
  /** The Sharer revoked this Guest. */
  revoked?: boolean;
  onSelect: (serviceId: string) => void;
  onCloseSession: () => void;
  /**
   * What the frame shows. In the app it is the Service in its own isolated
   * origin (`src`, ADR 0003); here a stand-in document.
   */
  frameFor?: (service: ViewerService) => { src?: string; srcDoc?: string };
}

const dot: Record<LinkState, string> = {
  connected: "bg-success",
  connecting: "bg-warning animate-pulse",
  offline: "bg-destructive",
};

const demoDoc = (service: ViewerService, sharer: string) =>
  `<!doctype html><html><body style="font-family:system-ui;margin:2rem">
<h1>${service.name}</h1><p>A page served by ${sharer}'s computer.</p></body></html>`;

function Notice({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="grid flex-1 place-content-center gap-2 p-8 text-center">
      <p className="font-medium">{title}</p>
      <p className="text-muted-foreground max-w-md text-sm">{children}</p>
    </div>
  );
}

function CloseSession({ sharerName, onClose }: { sharerName: string; onClose: () => void }) {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button size="sm" variant="outline">
          Close session
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Close the session?</AlertDialogTitle>
          <AlertDialogDescription>
            You leave {sharerName}'s services and this browser forgets the invite. To come back you
            need a new invite from {sharerName}. Just closing the tab keeps you in.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Stay</AlertDialogCancel>
          <AlertDialogAction onClick={onClose}>Close and forget</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** The Guest's view: whose services these are, which one, and the Service itself. */
export function ViewerFrame({
  sharerName,
  services,
  selected,
  link,
  revoked = false,
  onSelect,
  onCloseSession,
  frameFor = (s) => ({ srcDoc: demoDoc(s, sharerName) }),
}: ViewerFrameProps) {
  const service = services.find((s) => s.id === selected) ?? services[0];

  let body: ReactNode;
  if (revoked) {
    body = (
      <Notice title={`${sharerName} removed your access`}>
        Their services are no longer open to this browser. Ask {sharerName} for a new invite if you
        need them again.
      </Notice>
    );
  } else if (service == null) {
    body = (
      <Notice title={`${sharerName} isn't sharing anything right now`}>
        This page shows their services as soon as they share one.
      </Notice>
    );
  } else if (service.paused) {
    body = (
      <Notice title={`${sharerName} paused ${service.name}`}>
        <PauseCircle className="mx-auto mb-2 size-6" />
        It comes back here as soon as {sharerName} turns it on again.
      </Notice>
    );
  } else {
    body = (
      <iframe
        title={`${service.name}, shared by ${sharerName}`}
        className={cn("w-full flex-1 border-0", link === "offline" && "opacity-50")}
        {...frameFor(service)}
      />
    );
  }

  return (
    <div className="bg-background flex h-full min-h-96 w-full flex-col border">
      <header className="flex flex-wrap items-center gap-3 border-b px-4 py-2">
        <span className="text-muted-foreground text-sm">SandClaw.ai presents:</span>
        <span className="flex items-center gap-2 font-medium">
          <span className={cn("size-2 rounded-full", dot[link])} title={link} />
          {sharerName}
        </span>
        <span className="flex-1" />
        {!revoked && <CloseSession sharerName={sharerName} onClose={onCloseSession} />}
      </header>
      {!revoked && services.length > 1 && service != null && (
        <div className="border-b px-4 py-2">
          <Choice
            label="Services"
            value={service.id}
            options={services.map((s) => ({ value: s.id, text: s.name }))}
            onChange={onSelect}
          />
        </div>
      )}
      {link === "offline" && !revoked && (
        <p className="border-warning/60 bg-warning/10 border-b px-4 py-2 text-sm">
          {sharerName}'s computer isn't answering. The page reconnects by itself when {sharerName}{" "}
          is back.
        </p>
      )}
      {body}
    </div>
  );
}
