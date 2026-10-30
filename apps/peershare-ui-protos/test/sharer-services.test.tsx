import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Service } from "../src/model.js";
import { SharerServices, type SharerServicesProps } from "../src/peershare/sharer-services.js";

afterEach(cleanup);

const noop = () => {};
function renderPanel(props: Partial<SharerServicesProps> = {}) {
  return render(
    <SharerServices
      sharerName="Dirk"
      services={[]}
      onExpose={noop}
      onProbe={noop}
      onToggle={noop}
      onInvite={noop}
      {...props}
    />,
  );
}

describe("U1 — the Sharer's services", () => {
  it("'Expose service' is disabled until a URL is given", () => {
    renderPanel();
    const expose = screen.getByRole("button", { name: "Expose service" });
    expect(expose).toHaveProperty("disabled", true);

    fireEvent.change(screen.getByLabelText("Local URL to expose"), {
      target: { value: "http://localhost:5173" },
    });
    expect(expose).toHaveProperty("disabled", false);
  });

  it("exposing a local URL reports it as Bridged, with the name and default flag", () => {
    const onExpose = vi.fn();
    renderPanel({ onExpose });
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "fooService" } });
    fireEvent.change(screen.getByLabelText("Local URL to expose"), {
      target: { value: "http://localhost:5173" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Expose service" }));

    expect(onExpose).toHaveBeenCalledWith(
      { name: "fooService", target: "http://localhost:5173", isDefault: true },
      "bridged",
    );
  });

  it("a remote address that is not https is refused, with the reason, and nothing is exposed", () => {
    const onExpose = vi.fn();
    renderPanel({ onExpose });
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "docs" } });
    fireEvent.change(screen.getByLabelText("Local URL to expose"), {
      target: { value: "http://docs.example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Expose service" }));

    expect(screen.getByText("A remote service must use https://.")).toBeTruthy();
    expect(onExpose).not.toHaveBeenCalled();
  });

  const foo: Service = {
    id: "foo",
    name: "fooService",
    kind: "bridged",
    target: "http://localhost:5173",
    enabled: true,
    isDefault: true,
    health: "ok",
    warnings: [],
  };

  it("a shared service says what it exposes, and its buttons call back", () => {
    const onProbe = vi.fn();
    const onToggle = vi.fn();
    renderPanel({ services: [foo], onProbe, onToggle });

    expect(screen.getByText("http://localhost:5173")).toBeTruthy();
    expect(screen.getByText(/exposing/).textContent).toContain("through the Bridge");
    fireEvent.click(screen.getByRole("button", { name: "Test again" }));
    fireEvent.click(screen.getByRole("button", { name: "Turn off" }));
    expect(onProbe).toHaveBeenCalledWith("foo");
    expect(onToggle).toHaveBeenCalledWith("foo");
  });

  it("a service that is down says what to check", () => {
    renderPanel({ services: [{ ...foo, health: "down" }] });
    expect(screen.getByText(/Check that it is running on this computer/)).toBeTruthy();
  });

  it("invites only while a service is on and the server is on", () => {
    const onInvite = vi.fn();
    const { rerender } = renderPanel({ services: [{ ...foo, enabled: false }], onInvite });
    const invite = () => screen.getByRole("button", { name: "Invite Guest User" });
    expect(invite()).toHaveProperty("disabled", true);

    const props = { sharerName: "Dirk", onExpose: noop, onProbe: noop, onToggle: noop, onInvite };
    rerender(<SharerServices {...props} services={[foo]} serverOn={false} />);
    expect(invite()).toHaveProperty("disabled", true);

    rerender(<SharerServices {...props} services={[foo]} />);
    fireEvent.click(invite());
    expect(onInvite).toHaveBeenCalled();
  });
});
