import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { INVITE_TTL_MS } from "../src/model.js";
import { InviteDialog } from "../src/peershare/invite-dialog.js";

afterEach(cleanup);

const now = new Date("2026-10-30T10:00:00Z");
const invite = {
  url: "https://tools.sandclaw.ai/invite#k=a41d07b9c2",
  expiresAt: new Date(now.getTime() + INVITE_TTL_MS),
  used: false,
};

describe("U2 — the invite modal", () => {
  it("Copy puts the exact link on the clipboard; it says the link works once, for 24 hours", () => {
    const writeText = vi.fn(async () => {});
    Object.assign(navigator, { clipboard: { writeText } });
    render(<InviteDialog open invite={invite} now={now} onClose={() => {}} />);

    fireEvent.click(screen.getByRole("button", { name: "Copy link" }));
    expect(writeText).toHaveBeenCalledWith(invite.url);
    expect(screen.getByText(/works once, for 24 hours/)).toBeTruthy();
  });

  it("shows the link as a QR code a phone camera can open", () => {
    render(<InviteDialog open invite={invite} now={now} onClose={() => {}} />);
    expect(screen.getByRole("img", { name: "QR code of the invite link" })).toBeTruthy();
  });

  it("a used link says so, instead of offering it again", () => {
    render(<InviteDialog open invite={{ ...invite, used: true }} now={now} onClose={() => {}} />);
    expect(screen.getByText(/has been used/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Copy link" })).toBeNull();
  });
});
