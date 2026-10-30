import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import type { LinkState } from "../vendor/group-status/group-status.js";
import { ViewerFrame, type ViewerService } from "./viewer-frame.js";

function Live({
  services,
  link = "connected",
  revoked,
}: {
  services: ViewerService[];
  link?: LinkState;
  revoked?: boolean;
}) {
  const [selected, setSelected] = useState(services[0]?.id ?? "");
  const [closed, setClosed] = useState(false);
  if (closed) return <p className="p-6 text-sm">Session closed: this browser forgot the invite.</p>;
  return (
    <div className="h-[32rem] p-6">
      <ViewerFrame
        sharerName="Dirk"
        services={services}
        selected={selected}
        link={link}
        revoked={revoked}
        onSelect={setSelected}
        onCloseSession={() => setClosed(true)}
      />
    </div>
  );
}

const foo = { id: "foo", name: "fooService", paused: false };

const meta = {
  title: "PeerShare/Guest/Viewer",
  component: Live,
} satisfies Meta<typeof Live>;
export default meta;
type Story = StoryObj<typeof meta>;

/** "SandClaw.ai presents: Dirk [Close session]" over the service. */
export const OneService: Story = { args: { services: [foo] } };

/** Several: a picker, default first. */
export const Several: Story = {
  args: {
    services: [
      foo,
      { id: "docs", name: "Product docs", paused: false },
      { id: "nas", name: "Photos", paused: true },
    ],
  },
};

export const Paused: Story = { args: { services: [{ ...foo, paused: true }] } };

/** Dirk's tab closed or "Turn off server": reconnects by itself. */
export const SharerOffline: Story = { args: { services: [foo], link: "offline" } };

export const Revoked: Story = { args: { services: [foo], revoked: true } };

export const NothingShared: Story = { args: { services: [] } };
