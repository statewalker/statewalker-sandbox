import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import type { Guest } from "../model.js";
import { guests } from "./fixtures.js";
import { GuestList } from "./guests.js";

function Live({ initial }: { initial: Guest[] }) {
  const [list, setList] = useState(initial);
  return (
    <div className="p-6">
      <GuestList
        guests={list}
        onRevoke={(id) => setList((l) => l.filter((g) => g.peerId !== id))}
      />
    </div>
  );
}

const meta = {
  title: "PeerShare/Sharer/Guests",
  component: Live,
} satisfies Meta<typeof Live>;
export default meta;
type Story = StoryObj<typeof meta>;

/** Claudia online, Marc offline; Revoke asks first. */
export const TwoGuests: Story = { args: { initial: guests } };

export const NobodyYet: Story = { args: { initial: [] } };
