import { describe, expect, it } from "vitest";
import { isLoopbackHost, peerRows, shellRules, statusBarText } from "../src/common/mesh-model";

const view = {
  version: 3,
  self: "12D3KooWSelf",
  members: [
    { peerId: "12D3KooWZed", roles: ["member"], online: false, addrs: [] },
    { peerId: "12D3KooWHub", roles: ["admin"], online: true, addrs: [] },
    { peerId: "12D3KooWAmy", roles: ["member"], online: true, addrs: [] },
    { peerId: "12D3KooWSelf", roles: ["admin"], online: true, addrs: [] },
  ],
  advertisements: [
    { peerId: "12D3KooWHub", id: "llm", kind: "openapi-service", title: "LLM" },
    { peerId: "12D3KooWAmy", id: "proxy", kind: "proxy", title: "Proxy" },
    { peerId: "12D3KooWGone", id: "x", kind: "x", title: "Orphan" },
  ],
};

describe("peerRows", () => {
  it("is empty without a mesh view", () => {
    expect(peerRows(null, "12D3KooWHub")).toEqual([]);
  });

  it("lists this peer first, the hub second, then online before offline", () => {
    expect(peerRows(view, "12D3KooWHub").map((r) => r.peerId)).toEqual([
      "12D3KooWSelf",
      "12D3KooWHub",
      "12D3KooWAmy",
      "12D3KooWZed",
    ]);
  });

  it("marks self and hub and attaches each peer's services", () => {
    const rows = peerRows(view, "12D3KooWHub");
    expect(rows[0]).toMatchObject({ isSelf: true, isHub: false, roles: ["admin"] });
    expect(rows[1]).toMatchObject({
      isHub: true,
      services: [{ id: "llm", kind: "openapi-service", title: "LLM" }],
    });
    expect(rows[2].services).toEqual([{ id: "proxy", kind: "proxy", title: "Proxy" }]);
    expect(rows[3]).toMatchObject({ online: false, services: [] });
  });

  it("adds the hub when the view does not list it as a member, with its services", () => {
    const withoutHub = { ...view, members: view.members.filter((m) => m.peerId !== "12D3KooWHub") };
    const rows = peerRows(withoutHub, "12D3KooWHub");
    expect(rows.map((r) => r.peerId)).toEqual([
      "12D3KooWSelf",
      "12D3KooWHub",
      "12D3KooWAmy",
      "12D3KooWZed",
    ]);
    expect(rows[1]).toMatchObject({
      isHub: true,
      online: true,
      roles: [],
      services: [{ id: "llm", kind: "openapi-service", title: "LLM" }],
    });
  });

  it("drops advertisements of peers that are not members", () => {
    const all = peerRows(view, "12D3KooWHub").flatMap((r) => r.services.map((s) => s.title));
    expect(all).not.toContain("Orphan");
  });
});

describe("statusBarText", () => {
  it("names the phase, and the link when live", () => {
    expect(statusBarText({ phase: { kind: "checking" }, hubLink: null })).toBe("Mesh: checking");
    expect(
      statusBarText({ phase: { kind: "starting", peerState: "dialing-hub" }, hubLink: null }),
    ).toBe("Mesh: dialing hub");
    expect(
      statusBarText({
        phase: { kind: "live", joinedBy: "resume", note: null },
        hubLink: "direct",
      }),
    ).toBe("Mesh: live (direct)");
    expect(
      statusBarText({
        phase: { kind: "needs-invitation", reason: "no-identity", message: "…" },
        hubLink: null,
      }),
    ).toBe("Mesh: not joined");
    expect(statusBarText(null)).toBe("Mesh: off");
  });
});

describe("isLoopbackHost", () => {
  it("is true for loopback names and addresses only", () => {
    for (const host of ["localhost", "127.0.0.1", "127.8.0.1", "[::1]"]) {
      expect(isLoopbackHost(host)).toBe(true);
    }
    for (const host of ["example.com", "10.0.0.1", "localhost.example.com"]) {
      expect(isLoopbackHost(host)).toBe(false);
    }
  });
});

describe("shellRules", () => {
  it("parses, and is built once", () => {
    expect(shellRules()).toBe(shellRules());
  });
});
