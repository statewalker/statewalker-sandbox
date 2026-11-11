import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import type { Service } from "../model.js";
import { docs, fooService, nas } from "./fixtures.js";
import { SharerServices } from "./sharer-services.js";

/** The screen with its own little state, so a story can be clicked through. */
function Live({
  initial,
  serverOn = true,
  adding,
}: {
  initial: Service[];
  serverOn?: boolean;
  adding?: boolean;
}) {
  const [name, setName] = useState("Dirk");
  const [list, setList] = useState(initial);
  const [on, setOn] = useState(serverOn);
  const set = (id: string, change: Partial<Service>) =>
    setList((l) => l.map((s) => (s.id === id ? { ...s, ...change } : s)));
  return (
    <div className="p-6">
      <SharerServices
        sharerName={name}
        onSharerNameChange={setName}
        services={list}
        serverOn={on}
        adding={adding}
        onExpose={(draft, kind) =>
          setList((l) => [
            ...l,
            { id: crypto.randomUUID(), ...draft, kind, enabled: true, health: "ok", warnings: [] },
          ])
        }
        onEdit={(id, draft, kind) => set(id, { ...draft, kind })}
        onProbe={(id) => set(id, { health: "ok" })}
        onToggle={(id) => {
          const s = list.find((x) => x.id === id);
          if (s) set(id, { enabled: !s.enabled, health: s.enabled ? "disabled" : "ok" });
        }}
        onInvite={() => {}}
        onServer={setOn}
      />
    </div>
  );
}

const meta = {
  title: "PeerShare/Sharer/Services",
  component: Live,
} satisfies Meta<typeof Live>;
export default meta;
type Story = StoryObj<typeof meta>;

/** First visit: the name, one form, and "Expose service" disabled until a URL is typed. */
export const Empty: Story = { args: { initial: [] } };

/** After adding one: "fooService exposing http://localhost:5173". */
export const OneService: Story = { args: { initial: [fooService] } };

/** A local one through the Bridge, a remote https one directly, one turned off. */
export const Several: Story = { args: { initial: [fooService, docs, nas] } };

export const Probing: Story = { args: { initial: [{ ...fooService, health: "checking" }] } };

/** Down, with what to check; and a remote one that sends no CORS headers. */
export const DownWithAdvice: Story = {
  args: {
    initial: [
      { ...fooService, health: "down" },
      { ...docs, health: "down", warnings: ["cors-missing"] },
    ],
  },
};

/** The probe's warnings: things that will not work for guests. */
export const Warnings: Story = {
  args: { initial: [{ ...fooService, health: "slow", warnings: ["ws-needed", "cookies-set"] }] },
};

export const ServerOff: Story = { args: { initial: [fooService], serverOn: false } };

export const AddingAnother: Story = { args: { initial: [fooService], adding: true } };
