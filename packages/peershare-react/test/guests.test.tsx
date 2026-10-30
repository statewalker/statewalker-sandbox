import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { GuestList } from "../src/views/guests.js";
import type { Guest } from "../src/views/model.js";

afterEach(cleanup);

const guests: Guest[] = [
  {
    peerId: "12D3KooWClaudia",
    name: "Claudia",
    joinedAt: new Date("2026-10-30T09:00:00Z"),
    online: true,
  },
  {
    peerId: "12D3KooWMarc",
    name: "Marc",
    joinedAt: new Date("2026-10-29T15:00:00Z"),
    online: false,
  },
];

/** The list as the app holds it: revoking removes the Guest. */
function Owner() {
  const [list, setList] = useState(guests);
  return (
    <GuestList guests={list} onRevoke={(id) => setList((l) => l.filter((g) => g.peerId !== id))} />
  );
}

describe("U5 — guests", () => {
  it("Revoke asks to confirm, then the guest is gone", async () => {
    render(<Owner />);
    fireEvent.click(screen.getAllByRole("button", { name: "Revoke" })[0] as HTMLElement);

    const confirm = await screen.findByRole("alertdialog");
    expect(confirm.textContent).toContain("Claudia loses access at once");
    fireEvent.click(screen.getByRole("button", { name: "Revoke Claudia" }));

    expect(screen.queryByText("Claudia")).toBeNull();
    expect(screen.getByText("Marc")).toBeTruthy();
  });

  it("Cancel keeps the guest", async () => {
    render(<Owner />);
    fireEvent.click(screen.getAllByRole("button", { name: "Revoke" })[0] as HTMLElement);
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(screen.getByText("Claudia")).toBeTruthy();
  });

  it("with nobody invited yet, says how to invite", () => {
    render(<GuestList guests={[]} onRevoke={() => {}} />);
    expect(screen.getByText(/No guests yet/)).toBeTruthy();
  });
});
