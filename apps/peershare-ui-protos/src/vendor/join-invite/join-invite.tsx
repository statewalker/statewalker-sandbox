import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  Label,
  Textarea,
} from "@statewalker/ui.view.shadcn";
import { FolderOpen, HardDrive, Loader2, Lock, MonitorSmartphone, ShieldCheck } from "lucide-react";
import { useState } from "react";
import { group, pendingInvites } from "../mock.js";

/**
 * How the invite page explains itself:
 * - `minimal`: one card, one button, privacy in one line;
 * - `promises`: the three promises first, then join.
 */
export type JoinVariant = "minimal" | "promises";

/**
 * How the hub answers when the browser sends Join or Decline. `joined` means the
 * hub took the answer: after Decline it leads to the "you declined" page.
 */
export type JoinOutcome = "joined" | "machine-offline" | "invite-used" | "invite-expired";

type Stage =
  | "invite"
  | "joining"
  | JoinOutcome
  | "opening"
  | "decline"
  | "declining"
  | "declined"
  | "decline-offline";

export interface JoinFlowProps {
  variant?: JoinVariant;
  outcome?: JoinOutcome;
  /** Where the story starts; the flow then runs on its own. */
  start?: "invite" | "joined" | "decline" | "declined";
  /** How long the hub takes to answer Join or Decline, in ms. */
  joinMs?: number;
}

/** When the invite stops working by itself (Paul's pending invite in the mock). */
const expiresOn = pendingInvites[0]?.expiresAt.toLocaleDateString("en-GB", {
  weekday: "long",
  day: "numeric",
  month: "long",
  timeZone: "UTC",
});

const promises = [
  {
    icon: HardDrive,
    title: "The assistant runs on your group's Sandclaw machine",
    text: "Your questions never go to an outside AI company.",
  },
  {
    icon: MonitorSmartphone,
    title: "Your files stay on this device",
    text: "Documents and chats are kept in this browser, not on a server.",
  },
  {
    icon: ShieldCheck,
    title: "Only your group's devices can read the connection",
    text: "It is end-to-end encrypted, even on public Wi-Fi.",
  },
];

function Frame({ children }: { children: React.ReactNode }) {
  return <Card className="w-full max-w-md">{children}</Card>;
}

/** Where the flow ends without joining: used, expired or declined — only the words differ. */
function EndPage({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Frame>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription className="grid gap-2">{children}</CardDescription>
      </CardHeader>
    </Frame>
  );
}

export function JoinFlow({
  variant = "minimal",
  outcome = "joined",
  start = "invite",
  joinMs = 1200,
}: JoinFlowProps) {
  const [stage, setStage] = useState<Stage>(start);
  const [note, setNote] = useState("");
  const join = () => {
    setStage("joining");
    setTimeout(() => setStage(outcome), joinMs);
  };
  // Decline is an answer the hub records (the admin's log shows it), so it can
  // fail the same ways Join does.
  const decline = () => {
    setStage("declining");
    const answer: Record<JoinOutcome, Stage> = {
      joined: "declined",
      "machine-offline": "decline-offline",
      "invite-used": "invite-used",
      "invite-expired": "invite-expired",
    };
    setTimeout(() => setStage(answer[outcome]), joinMs);
  };

  if (stage === "joined" || stage === "opening") {
    return (
      <Frame>
        <CardHeader>
          <CardTitle>You&apos;re in {group.name}</CardTitle>
          <CardDescription>
            Choose the folder the assistant works with. It can read what is in it, and it asks
            before changing anything.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-2">
          <Button disabled={stage === "opening"} onClick={() => setStage("opening")}>
            {stage === "opening" ? <Loader2 className="animate-spin" /> : <FolderOpen />} Open a
            folder on this computer
          </Button>
          <Button
            variant="outline"
            disabled={stage === "opening"}
            onClick={() => setStage("opening")}
          >
            Start with an empty folder in this browser
          </Button>
        </CardContent>
      </Frame>
    );
  }

  if (stage === "invite-used") {
    return (
      <EndPage title="This invite link has already been used">
        <span>Each invite works once. Ask {group.admin} for a new link.</span>
      </EndPage>
    );
  }

  if (stage === "invite-expired") {
    return (
      <EndPage title="This invite has expired">
        <span>
          Invites work for a week, and this one ran out before it was used. Ask {group.admin} for a
          new link.
        </span>
      </EndPage>
    );
  }

  if (stage === "declined") {
    return (
      <EndPage title={`You declined the invite to ${group.name}`}>
        <span>
          {group.admin} will see you declined{note.trim() ? ", with your note" : ""}. Nothing was
          stored in this browser; you can close this tab.
        </span>
        <span>
          Changed your mind? This link no longer works — ask {group.admin} for a new invite.
        </span>
      </EndPage>
    );
  }

  const offline = stage === "machine-offline";
  const joining = stage === "joining";
  const declining = stage === "declining";
  const declineOffline = stage === "decline-offline";
  const confirming = stage === "decline" || declining || declineOffline;

  const offlineNote = offline && (
    <p className="border-warning/60 rounded-md border p-3 text-sm">
      The Sandclaw machine isn&apos;t answering. Ask {group.admin} to check it&apos;s switched on,
      then try again.
    </p>
  );

  // Decline sits under Join as a quiet text button; pressing it asks once, in place.
  const footer = confirming ? (
    <CardFooter className="grid gap-3">
      <div className="grid gap-1">
        <div className="text-sm font-medium">Decline the invite?</div>
        <p className="text-muted-foreground text-sm">
          {group.admin} will see you declined. This link stops working.
        </p>
      </div>
      {declineOffline ? (
        <p className="border-warning/60 rounded-md border p-3 text-sm">
          The Sandclaw machine isn&apos;t answering, so your answer can&apos;t be recorded now and{" "}
          {group.admin} won&apos;t see it. You can simply close this tab: nothing was stored in this
          browser, and the invite expires by itself on {expiresOn}.
        </p>
      ) : (
        <div className="grid gap-1.5">
          <Label htmlFor="decline-note">Note to {group.admin} (optional)</Label>
          <Textarea
            id="decline-note"
            placeholder="e.g. Wrong address — I'm not at the atelier any more."
            value={note}
            disabled={declining}
            onChange={(e) => setNote(e.target.value)}
          />
        </div>
      )}
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="ghost" disabled={declining} onClick={() => setStage("invite")}>
          Back to the invite
        </Button>
        <Button variant="outline" disabled={declining} onClick={decline}>
          {declining ? (
            <>
              <Loader2 className="animate-spin" /> Declining…
            </>
          ) : declineOffline ? (
            "Try again"
          ) : (
            "Decline invite"
          )}
        </Button>
      </div>
    </CardFooter>
  ) : (
    <CardFooter className="grid gap-1">
      <Button className="w-full" disabled={joining} onClick={join}>
        {joining ? (
          <>
            <Loader2 className="animate-spin" /> Joining {group.name}…
          </>
        ) : offline ? (
          "Try again"
        ) : (
          `Join ${group.name}`
        )}
      </Button>
      <Button
        variant="ghost"
        size="sm"
        className="text-muted-foreground"
        disabled={joining}
        onClick={() => setStage("decline")}
      >
        Decline
      </Button>
    </CardFooter>
  );

  return (
    <Frame>
      <CardHeader>
        <CardTitle>
          {group.admin} invited you to {group.name}
        </CardTitle>
        <CardDescription>
          A private assistant for your documents. Nothing to install.
        </CardDescription>
      </CardHeader>
      {variant === "minimal" ? (
        <CardContent className="grid gap-3">
          {offlineNote}
          <p className="text-muted-foreground flex items-center gap-2 text-xs">
            <Lock className="size-3.5" /> Your files and questions stay within {group.name}.
          </p>
        </CardContent>
      ) : (
        <CardContent className="grid gap-4">
          {promises.map(({ icon: Icon, title, text }) => (
            <div key={title} className="flex gap-3">
              <Icon className="text-muted-foreground mt-0.5 size-5 shrink-0" />
              <div>
                <div className="text-sm font-medium">{title}</div>
                <div className="text-muted-foreground text-sm">{text}</div>
              </div>
            </div>
          ))}
          {offlineNote}
        </CardContent>
      )}
      {footer}
    </Frame>
  );
}
