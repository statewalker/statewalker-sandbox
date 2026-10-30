/**
 * M7 — the Guest's screen, wired. The real Guest needs a mesh, which jsdom
 * cannot host; here a stand-in PeerShare answers at the views' seam (the
 * model and the commands). The real one is tested in @statewalker/peershare.
 */

import {
  CloseSession,
  createRuntime,
  type GuestState,
  Join,
  ListSharedServices,
  type PeerShareSnapshot,
  peershareModelSlot,
} from "@statewalker/peershare";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GuestScreen, PeerShareProvider } from "../src/connected/index.js";

afterEach(cleanup);

function standInPeerShare() {
  const rt = createRuntime();
  let snapshot: PeerShareSnapshot = {
    sharer: { name: "", services: [] },
    sharing: { sharing: false },
    guests: [],
    guest: { stage: "no-link" },
  };
  const listeners = new Set<() => void>();
  const setGuest = (guest: GuestState) => {
    snapshot = { ...snapshot, guest };
    for (const l of listeners) l();
  };
  rt.slots.provide(peershareModelSlot, {
    getSnapshot: () => snapshot,
    subscribe: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  });
  const joined = vi.fn(async ({ link }: { link: string }) => {
    void link;
    const state: GuestState = { stage: "joined", sharerName: "Dirk", sharerPeerId: "12D3KooWDirk" };
    setGuest(state);
    return state;
  });
  rt.commands.listen(Join, (cmd) => joined(cmd.payload));
  rt.commands.listen(ListSharedServices, () =>
    Promise.resolve([
      { id: "foo", name: "fooService", isDefault: true, paused: false },
      { id: "wiki", name: "Team wiki", isDefault: false, paused: true },
    ]),
  );
  const closed = vi.fn(async () => {
    setGuest({ stage: "no-link" });
    return { stage: "no-link" } as GuestState;
  });
  rt.commands.listen(CloseSession, () => closed());
  return { rt, joined, closed };
}

describe("M7 — GuestScreen", () => {
  it("Join sends the link; the Viewer then lists Dirk's Services; Close session ends it", async () => {
    const { rt, joined, closed } = standInPeerShare();
    render(
      <PeerShareProvider rt={rt}>
        <GuestScreen
          link="https://tools.sandclaw.ai/peer-share/invite#join=x&from=Dirk"
          sharerName="Dirk"
        />
      </PeerShareProvider>,
    );

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Join Dirk/ }));
    });
    expect(joined).toHaveBeenCalledWith({
      link: "https://tools.sandclaw.ai/peer-share/invite#join=x&from=Dirk",
    });
    expect(await screen.findByText(/Team wiki/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Close session/ }));
    await act(async () => {
      fireEvent.click(await screen.findByRole("button", { name: "Close and forget" }));
    });
    expect(closed).toHaveBeenCalled();
    expect(await screen.findByRole("button", { name: /Join Dirk/ })).toBeTruthy();
  });
});
