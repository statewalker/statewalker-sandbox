import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BridgeDiagnosis } from "../src/model.js";
import { BridgeStatus } from "../src/peershare/bridge-status.js";

afterEach(cleanup);

describe("Bridge status — what the page tells the Sharer about the Bridge", () => {
  it("before the first call, explains the browser's local network prompt and waits for a click", () => {
    const onCheck = vi.fn();
    render(<BridgeStatus permission="prompt" onCheck={onCheck} />);

    expect(screen.getByText(/devices on your local network/)).toBeTruthy();
    expect(screen.getByText(/choose “Allow”/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Connect to the Bridge" }));
    expect(onCheck).toHaveBeenCalled();
  });

  it("while the browser waits for the Sharer's answer, says so rather than 'not running'", () => {
    render(<BridgeStatus permission="prompt" diagnosis="checking" onCheck={() => {}} />);
    expect(screen.getByText(/Waiting for your answer/)).toBeTruthy();
  });

  it.each<[BridgeDiagnosis, RegExp, RegExp]>([
    ["ok", /Bridge connected/, /share services on this computer/],
    ["permission-needed", /blocked access to your local network/, /site settings/],
    ["bridge-not-running", /Bridge isn't running/, /Start the PeerShare Bridge/],
    ["token-rejected", /restarted/, /link the Bridge printed/],
  ])("%s: says what happened and what to do", (diagnosis, what, todo) => {
    render(<BridgeStatus permission="granted" diagnosis={diagnosis} onCheck={() => {}} />);
    expect(screen.getByText(what)).toBeTruthy();
    expect(screen.getByText(todo)).toBeTruthy();
  });

  it("offers 'Check again' whenever something is wrong", () => {
    const onCheck = vi.fn();
    render(<BridgeStatus permission="granted" diagnosis="bridge-not-running" onCheck={onCheck} />);
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    expect(onCheck).toHaveBeenCalled();
  });
});
