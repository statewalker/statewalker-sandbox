import { describe, expect, it } from "vitest";
import { matchRoute, type ProxyRoute, upstreamUrl } from "../src/services/proxy-routes.js";

const OPENAI: ProxyRoute = {
  prefix: "/openai",
  upstream: "https://api.openai.com/v1",
  headers: {},
};
const ADMIN: ProxyRoute = {
  prefix: "/openai/admin",
  upstream: "https://admin.example/v2",
  headers: {},
};

describe("matchRoute", () => {
  it("matches a prefix and returns the remainder", () => {
    expect(matchRoute([OPENAI], "/openai/models")).toEqual({ route: OPENAI, rest: "/models" });
  });

  it("matches the prefix exactly, with an empty remainder", () => {
    expect(matchRoute([OPENAI], "/openai")).toEqual({ route: OPENAI, rest: "" });
  });

  // Longest wins, so a more specific prefix can be routed elsewhere.
  it("prefers the longest matching prefix regardless of array order", () => {
    expect(matchRoute([OPENAI, ADMIN], "/openai/admin/keys")?.route).toBe(ADMIN);
    expect(matchRoute([ADMIN, OPENAI], "/openai/admin/keys")?.route).toBe(ADMIN);
  });

  // Spec acceptance criterion 8: a prefix is a path segment, not a string prefix.
  it("only matches on segment boundaries", () => {
    const open: ProxyRoute = { prefix: "/open", upstream: "https://open.example", headers: {} };
    expect(matchRoute([open], "/openai/models")).toBeNull();
  });

  it("returns null when nothing matches", () => {
    expect(matchRoute([OPENAI], "/matrix/sync")).toBeNull();
  });
});

describe("upstreamUrl", () => {
  it("joins the remainder onto the upstream base", () => {
    expect(upstreamUrl(OPENAI, "/models", "")).toBe("https://api.openai.com/v1/models");
  });

  it("carries the query string unchanged", () => {
    expect(upstreamUrl(OPENAI, "/models", "?limit=2&after=x")).toBe(
      "https://api.openai.com/v1/models?limit=2&after=x",
    );
  });

  it("does not double a slash when the base ends in one", () => {
    const trailing: ProxyRoute = { prefix: "/x", upstream: "https://e.example/v1/", headers: {} };
    expect(upstreamUrl(trailing, "/models", "")).toBe("https://e.example/v1/models");
  });

  it("hits the base itself when the remainder is empty", () => {
    expect(upstreamUrl(OPENAI, "", "")).toBe("https://api.openai.com/v1");
  });
});
