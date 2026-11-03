import type { Meta, StoryObj } from "@storybook/react-vite";
import { Scenario } from "./scenario.js";

/**
 * The whole usage scenario on one page: Dirk's computer on the left, Claudia's
 * phone on the right, joined by a fake mesh. Try: name a service, expose
 * http://localhost:5173, Invite Guest User, then on Claudia's side open the
 * link and Join Dirk; then Turn off, Turn off server, Revoke.
 */
const meta = {
  title: "PeerShare/Scenario",
  component: Scenario,
} satisfies Meta<typeof Scenario>;
export default meta;
type Story = StoryObj<typeof meta>;

export const DirkAndClaudia: Story = { args: { latencyMs: 600 } };
