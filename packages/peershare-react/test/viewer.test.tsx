import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ViewerFrame, type ViewerFrameProps } from "../src/views/viewer-frame.js";

afterEach(cleanup);

const two = [
  { id: "foo", name: "fooService", paused: false },
  { id: "wiki", name: "Team wiki", paused: true },
];

function renderViewer(props: Partial<ViewerFrameProps> = {}) {
  return render(
    <ViewerFrame
      sharerName="Dirk"
      services={two}
      selected="foo"
      link="connected"
      onSelect={() => {}}
      onCloseSession={() => {}}
      {...props}
    />,
  );
}

describe("U4 — the Guest's viewer", () => {
  it("Close session asks to confirm, then closes", async () => {
    const onCloseSession = vi.fn();
    renderViewer({ onCloseSession });

    expect(screen.getByText("SandClaw.ai presents:")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close session" }));
    const confirm = await screen.findByRole("alertdialog");
    expect(confirm.textContent).toContain("you need a new invite");
    expect(onCloseSession).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Close and forget" }));
    expect(onCloseSession).toHaveBeenCalled();
  });

  it("shows the chosen service in a frame, and a picker when there are several", () => {
    const onSelect = vi.fn();
    renderViewer({ onSelect });

    expect(screen.getByTitle("fooService, shared by Dirk")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Team wiki" }));
    expect(onSelect).toHaveBeenCalledWith("wiki");
  });

  it("a single service needs no picker", () => {
    renderViewer({ services: [{ id: "foo", name: "fooService", paused: false }] });
    expect(screen.queryByRole("button", { name: "fooService" })).toBeNull();
  });

  it("a paused service shows a paused page instead of the frame", () => {
    renderViewer({ selected: "wiki" });
    expect(screen.getByText("Dirk paused Team wiki")).toBeTruthy();
    expect(screen.queryByTitle("Team wiki, shared by Dirk")).toBeNull();
  });

  it("when Dirk's computer is offline, says so and that it reconnects by itself", () => {
    renderViewer({ link: "offline" });
    expect(screen.getByText(/Dirk's computer isn't answering/)).toBeTruthy();
    expect(screen.getByText(/reconnects by itself/)).toBeTruthy();
  });

  it("after Dirk revokes access, nothing of Dirk's is shown any more", () => {
    renderViewer({ revoked: true });
    expect(screen.getByText("Dirk removed your access")).toBeTruthy();
    expect(screen.queryByTitle(/shared by Dirk/)).toBeNull();
  });
});
