import type { Meta, StoryObj } from "@storybook/react-vite";
import { BridgeStatus } from "./bridge-status.js";

const meta = {
  title: "PeerShare/Sharer/Bridge",
  component: BridgeStatus,
  decorators: [
    (Story) => (
      <div className="p-6">
        <Story />
      </div>
    ),
  ],
  args: { onCheck: () => {} },
} satisfies Meta<typeof BridgeStatus>;
export default meta;
type Story = StoryObj<typeof meta>;

/** Before the first call: explain the browser's "local network" prompt, then ask. */
export const BeforeThePrompt: Story = { args: { permission: "prompt" } };

/** The call is out and the browser's prompt is showing: never "not running". */
export const WaitingForTheAnswer: Story = { args: { permission: "prompt", diagnosis: "checking" } };

export const Connected: Story = { args: { permission: "granted", diagnosis: "ok" } };

export const PermissionNeeded: Story = {
  args: { permission: "denied", diagnosis: "permission-needed" },
};

export const BridgeNotRunning: Story = {
  args: { permission: "granted", diagnosis: "bridge-not-running" },
};

export const TokenRejected: Story = {
  args: { permission: "granted", diagnosis: "token-rejected" },
};
