import {
  Button,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@statewalker/ui.view.shadcn";
import { Loader2, Lock } from "lucide-react";
import { EndPage, Frame } from "../vendor/join-invite/join-invite.js";
import type { JoinOutcome } from "./model.js";

/** Where the Guest is: the invite, waiting for the Sharer, or one of the Sharer's answers. */
export type JoinStage = "invite" | "joining" | Exclude<JoinOutcome, "joined">;

export interface GuestJoinProps {
  sharerName: string;
  stage: JoinStage;
  onJoin: () => void;
  onDecline: () => void;
}

/**
 * The page a Guest lands on from the invite link (camera or chat). Same frame
 * and end pages as ui-protos' JoinFlow; the stage comes from outside, because
 * it is the Sharer's tab that answers.
 */
export function GuestJoin({ sharerName, stage, onJoin, onDecline }: GuestJoinProps) {
  if (stage === "invite-used") {
    return (
      <EndPage title="This invite link has already been used">
        <span>Each link works once, for one person. Ask {sharerName} for a new link.</span>
      </EndPage>
    );
  }
  if (stage === "invite-expired") {
    return (
      <EndPage title="This invite has expired">
        <span>Invite links work for 24 hours. Ask {sharerName} for a new link.</span>
      </EndPage>
    );
  }
  if (stage === "declined") {
    return (
      <EndPage title={`You declined ${sharerName}'s invite`}>
        <span>Nothing was stored in this browser; you can close this tab.</span>
      </EndPage>
    );
  }

  const joining = stage === "joining";
  const offline = stage === "machine-offline";
  return (
    <Frame>
      <CardHeader>
        <CardTitle>{sharerName} invited you to see the services.</CardTitle>
        <CardDescription>
          Nothing to install: they open right here, in this browser.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        {offline && (
          <p className="border-warning/60 rounded-md border p-3 text-sm">
            {sharerName}'s computer isn't answering. Ask {sharerName} to check that PeerShare is
            open there, then try again.
          </p>
        )}
        <p className="text-muted-foreground flex items-center gap-2 text-xs">
          <Lock className="size-3.5" /> It is end-to-end encrypted, even on public Wi-Fi.
        </p>
        <p className="text-muted-foreground text-xs">
          You can reopen this link until you close the session.
        </p>
      </CardContent>
      <CardFooter className="grid gap-1">
        <Button className="w-full" disabled={joining} onClick={onJoin}>
          {joining ? (
            <>
              <Loader2 className="animate-spin" /> Joining {sharerName}…
            </>
          ) : offline ? (
            "Try again"
          ) : (
            `Join ${sharerName}`
          )}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="text-muted-foreground"
          disabled={joining}
          onClick={onDecline}
        >
          Decline
        </Button>
      </CardFooter>
    </Frame>
  );
}
