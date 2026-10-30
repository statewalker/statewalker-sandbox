import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GuestJoin, type JoinStage } from "../src/peershare/guest-join.js";

afterEach(cleanup);

const noop = () => {};

describe("U3 — the Guest opens the invite", () => {
  it.each<[JoinStage, RegExp, RegExp]>([
    ["invite-expired", /This invite has expired/, /Ask Dirk for a new link/],
    ["invite-used", /already been used/, /Ask Dirk for a new link/],
    ["machine-offline", /Dirk's computer isn't answering/, /Try again/],
    ["declined", /You declined Dirk's invite/, /close this tab/],
  ])("%s: says what happened and what to do next", (stage, what, next) => {
    render(<GuestJoin sharerName="Dirk" stage={stage} onJoin={noop} onDecline={noop} />);
    expect(screen.getByText(what)).toBeTruthy();
    expect(screen.getAllByText(next).length).toBeGreaterThan(0);
  });

  it("the invite: Join Dirk or Decline, and the promise of encryption", () => {
    const onJoin = vi.fn();
    const onDecline = vi.fn();
    render(<GuestJoin sharerName="Dirk" stage="invite" onJoin={onJoin} onDecline={onDecline} />);

    expect(screen.getByText("Dirk invited you to see the services.")).toBeTruthy();
    expect(screen.getByText(/end-to-end encrypted, even on public Wi-Fi/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Join Dirk" }));
    fireEvent.click(screen.getByRole("button", { name: "Decline" }));
    expect(onJoin).toHaveBeenCalled();
    expect(onDecline).toHaveBeenCalled();
  });

  it("while joining, the button says so and cannot be pressed twice", () => {
    render(<GuestJoin sharerName="Dirk" stage="joining" onJoin={noop} onDecline={noop} />);
    expect(screen.getByRole("button", { name: /Joining Dirk/ })).toHaveProperty("disabled", true);
  });

  it("offline: Try again joins again", () => {
    const onJoin = vi.fn();
    render(
      <GuestJoin sharerName="Dirk" stage="machine-offline" onJoin={onJoin} onDecline={noop} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onJoin).toHaveBeenCalled();
  });
});
