import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { GuestJoin, type JoinStage } from "./guest-join.js";

/** Join leads to `answer` after a moment, as the Sharer's tab would answer. */
function Live({ start = "invite", answer }: { start?: JoinStage; answer: JoinStage | "joined" }) {
  const [stage, setStage] = useState<JoinStage | "joined">(start);
  if (stage === "joined") {
    return <p className="p-6 text-sm">Joined: the viewer opens (see PeerShare/Guest/Viewer).</p>;
  }
  return (
    <div className="p-6">
      <GuestJoin
        sharerName="Dirk"
        stage={stage}
        onJoin={() => {
          setStage("joining");
          setTimeout(() => setStage(answer), 900);
        }}
        onDecline={() => setStage("declined")}
      />
    </div>
  );
}

const meta = {
  title: "PeerShare/Guest/Join",
  component: Live,
} satisfies Meta<typeof Live>;
export default meta;
type Story = StoryObj<typeof meta>;

/** "Dirk invited you to see the services." Join Dirk / Decline. */
export const Invite: Story = { args: { answer: "joined" } };

export const Joining: Story = { args: { start: "joining", answer: "joined" } };

/** Dirk's tab is closed: try again later. */
export const MachineOffline: Story = { args: { answer: "machine-offline" } };

export const AlreadyUsed: Story = { args: { start: "invite-used", answer: "invite-used" } };

export const Expired: Story = { args: { start: "invite-expired", answer: "invite-expired" } };

export const Declined: Story = { args: { start: "declined", answer: "declined" } };
