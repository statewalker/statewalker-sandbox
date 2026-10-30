import { Card } from "@statewalker/ui.view.shadcn";
import type { Guest } from "../model.js";
import { Confirm, Dot } from "../vendor/team/team.js";

export interface GuestListProps {
  guests: Guest[];
  onRevoke: (peerId: string) => void;
}

const joined = (at: Date) =>
  at.toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
  });

/** Who joined through the Sharer's invites, and the one thing to do about each: revoke. */
export function GuestList({ guests, onRevoke }: GuestListProps) {
  return (
    <Card className="w-full max-w-2xl gap-0 py-0">
      <div className="border-b p-4">
        <h2 className="font-semibold">Guests</h2>
        <p className="text-muted-foreground text-sm">Who can see your services.</p>
      </div>
      {guests.length === 0 ? (
        <p className="text-muted-foreground p-4 text-sm">
          No guests yet. “Invite Guest User” makes a link that admits one person.
        </p>
      ) : (
        <ul className="grid gap-2 p-4">
          {guests.map((guest) => (
            <li key={guest.peerId} className="flex items-center gap-2 text-sm">
              <Dot online={guest.online} />
              <span className="flex-1">
                {guest.name}
                <span className="text-muted-foreground"> · joined {joined(guest.joinedAt)}</span>
              </span>
              <Confirm
                trigger="Revoke"
                title={`Revoke ${guest.name}?`}
                action={`Revoke ${guest.name}`}
                onConfirm={() => onRevoke(guest.peerId)}
              >
                <span>
                  {guest.name} loses access at once: their next page load is refused, even with the
                  tab still open.
                </span>
                <span>To let them back in, send them a new invite.</span>
              </Confirm>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
