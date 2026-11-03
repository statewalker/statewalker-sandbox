import { Button } from "@statewalker/ui.view.shadcn";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import type { Invite } from "../model.js";
import { invite, now } from "./fixtures.js";
import { InviteDialog } from "./invite-dialog.js";

function Live({ value }: { value: Invite }) {
  const [open, setOpen] = useState(true);
  return (
    <div className="p-6">
      <Button onClick={() => setOpen(true)}>Invite Guest User</Button>
      <InviteDialog open={open} invite={value} now={now} onClose={() => setOpen(false)} />
    </div>
  );
}

const meta = {
  title: "PeerShare/Sharer/Invite",
  component: Live,
} satisfies Meta<typeof Live>;
export default meta;
type Story = StoryObj<typeof meta>;

/** A real QR code of the link, the link to copy, and "works once, for 24 hours". */
export const NewLink: Story = { args: { value: invite } };

export const AlmostExpired: Story = {
  args: { value: { ...invite, expiresAt: new Date(now.getTime() + 12 * 60_000) } },
};

export const Used: Story = { args: { value: { ...invite, used: true } } };
