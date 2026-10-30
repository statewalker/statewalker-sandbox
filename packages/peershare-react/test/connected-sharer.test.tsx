/** M7 — the Sharer's screen, wired to the real PeerShare logic through its model and commands. */

import { createRuntime, GetSharer, peershare, type SharerState } from "@statewalker/peershare";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { PeerShareProvider, SharerScreen } from "../src/connected/index.js";

afterEach(cleanup);

function runtimeWithPeerShare() {
  const rt = createRuntime();
  let saved: SharerState | undefined;
  peershare({
    store: {
      load: async () => saved,
      save: async (s) => {
        saved = s;
      },
    },
  }).contribute(rt);
  return rt;
}

describe("M7 — SharerScreen", () => {
  it("a Service typed into the form appears in the list, from the model", async () => {
    const rt = runtimeWithPeerShare();
    render(
      <PeerShareProvider rt={rt}>
        <SharerScreen />
      </PeerShareProvider>,
    );

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "fooService" } });
    fireEvent.change(screen.getByLabelText("Local URL to expose"), {
      target: { value: "http://localhost:5173" },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Expose service" }));
    });

    expect(await screen.findByText("fooService")).toBeTruthy();
    expect((await rt.commands.call(GetSharer, undefined).promise).services).toHaveLength(1);
  });

  it("Turn off pauses the Service through toggle-service", async () => {
    const rt = runtimeWithPeerShare();
    render(
      <PeerShareProvider rt={rt}>
        <SharerScreen />
      </PeerShareProvider>,
    );
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "foo" } });
    fireEvent.change(screen.getByLabelText("Local URL to expose"), {
      target: { value: "http://localhost:5173" },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Expose service" }));
    });

    await act(async () => {
      fireEvent.click(await screen.findByRole("button", { name: /Turn off$/ }));
    });

    expect((await rt.commands.call(GetSharer, undefined).promise).services[0]?.enabled).toBe(false);
  });
});
