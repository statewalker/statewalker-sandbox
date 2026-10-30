import { qrSvg } from "@statewalker/httpeers-qr";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@statewalker/ui.view.shadcn";
import { useMemo } from "react";
import type { Invite } from "../model.js";
import { CopyLink } from "../vendor/link-device/link-device.js";

export interface InviteDialogProps {
  open: boolean;
  invite: Invite;
  onClose: () => void;
  /** "Now", for the time left; the clock by default. */
  now?: Date;
}

/** "in 24 h", "in 3 h", "in 12 min". */
function timeLeft(expiresAt: Date, now: Date) {
  const min = Math.max(0, Math.round((expiresAt.getTime() - now.getTime()) / 60_000));
  return min >= 60 ? `in ${Math.round(min / 60)} h` : `in ${min} min`;
}

/**
 * The link as a real QR code (httpeers-qr): what a phone camera opens. The
 * SVG is generated here from the link, never from outside input, so it is
 * safe to insert.
 */
function InviteQr({ url }: { url: string }) {
  const svg = useMemo(() => qrSvg(url), [url]);
  return (
    <div
      role="img"
      aria-label="QR code of the invite link"
      className="mx-auto size-44 [&>svg]:size-full"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

export function InviteDialog({ open, invite, onClose, now = new Date() }: InviteDialogProps) {
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Invite a guest to your services</DialogTitle>
          <DialogDescription>
            Be careful whom you give access: whoever opens this link sees what you share.
          </DialogDescription>
        </DialogHeader>
        {invite.used ? (
          <p className="text-sm">
            This link has been used: a guest joined with it. Invite the next guest with a new link.
          </p>
        ) : (
          <div className="grid gap-4">
            <InviteQr url={invite.url} />
            <CopyLink link={invite.url} />
            <p className="text-muted-foreground text-sm">
              The link works once, for 24 hours (expires {timeLeft(invite.expiresAt, now)}). To
              invite someone else, make a new link here.
            </p>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
