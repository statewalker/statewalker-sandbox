/**
 * The whole usage scenario, clicked through on both sides: Dirk shares a
 * service and invites Claudia; Claudia joins and sees it; Dirk pauses it, then
 * revokes her. Only the mesh is fake (`src/scenario/fake-mesh.ts`).
 */

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Scenario } from "../src/scenario/scenario.js";

afterEach(cleanup);

const dirk = () => within(screen.getByRole("region", { name: "Dirk's computer" }));
const claudia = () => within(screen.getByRole("region", { name: "Claudia's phone" }));

async function shareFooService() {
  fireEvent.change(dirk().getByLabelText("Name"), { target: { value: "fooService" } });
  fireEvent.change(dirk().getByLabelText("Local URL to expose"), {
    target: { value: "http://localhost:5173" },
  });
  fireEvent.click(dirk().getByRole("button", { name: "Expose service" }));
  await dirk().findByText("Working");
}

async function inviteAndJoin() {
  fireEvent.click(dirk().getByRole("button", { name: "Invite Guest User" }));
  const dialog = await screen.findByRole("dialog");
  expect(within(dialog).getByText(/works once, for 24 hours/)).toBeTruthy();
  fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));

  fireEvent.click(claudia().getByRole("button", { name: "Open the link from Dirk" }));
  expect(claudia().getByText("Dirk invited you to see the services.")).toBeTruthy();
  fireEvent.click(claudia().getByRole("button", { name: "Join Dirk" }));
  await claudia().findByTitle("fooService, shared by Dirk");
}

describe("PeerShare — the full scenario", () => {
  it("share → probe → invite → join → view → pause → revoke", async () => {
    render(<Scenario />);
    await shareFooService();
    await inviteAndJoin();

    expect(dirk().getByText("Claudia")).toBeTruthy();

    fireEvent.click(dirk().getByRole("button", { name: "Turn off" }));
    await claudia().findByText("Dirk paused fooService");

    fireEvent.click(dirk().getByRole("button", { name: "Turn on" }));
    await claudia().findByTitle("fooService, shared by Dirk");

    fireEvent.click(dirk().getByRole("button", { name: "Revoke" }));
    fireEvent.click(await screen.findByRole("button", { name: "Revoke Claudia" }));
    await claudia().findByText("Dirk removed your access");
    expect(dirk().queryByText("Claudia")).toBeNull();
  });

  it("the same link a second time: already used", async () => {
    render(<Scenario />);
    await shareFooService();
    await inviteAndJoin();

    fireEvent.click(claudia().getByRole("button", { name: "Close session" }));
    fireEvent.click(await screen.findByRole("button", { name: "Close and forget" }));
    fireEvent.click(claudia().getByRole("button", { name: "Open the link from Dirk" }));
    fireEvent.click(claudia().getByRole("button", { name: "Join Dirk" }));
    await claudia().findByText("This invite link has already been used");
  });

  it("Dirk turns the server off: Claudia sees him offline, and back when he returns", async () => {
    render(<Scenario />);
    await shareFooService();
    await inviteAndJoin();

    fireEvent.click(dirk().getByRole("button", { name: "Turn off server" }));
    await claudia().findByText(/Dirk's computer isn't answering/);
    fireEvent.click(dirk().getByRole("button", { name: "Turn on server" }));
    expect(claudia().queryByText(/Dirk's computer isn't answering/)).toBeNull();
  });
});
