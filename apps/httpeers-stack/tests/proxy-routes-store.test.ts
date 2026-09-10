import { describe, expect, it } from "vitest";
import {
  ROUTES_STORAGE_KEY, type StoredRoute, loadRoutes, saveRoutes, withSecrets,
} from "../src/pages/proxy/routes-store.js";

const ROUTE: StoredRoute = {
  prefix: "/openai",
  upstream: "https://api.openai.com/v1",
  headers: { "content-type": "application/json" },
  secretHeader: "authorization",
};

function fakeStorage(seed?: string) {
  const map = new Map<string, string>();
  if (seed !== undefined) map.set(ROUTES_STORAGE_KEY, seed);
  return { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => { map.set(k, v); }, map };
}

describe("saveRoutes / loadRoutes", () => {
  it("round-trips routes", () => {
    const s = fakeStorage();
    saveRoutes(s, [ROUTE]);
    expect(loadRoutes(s)).toEqual([ROUTE]);
  });

  // The point of the whole module: a token is never written down.
  it("never writes a secret value, only the header's name", () => {
    const s = fakeStorage();
    saveRoutes(s, [ROUTE]);
    expect(s.map.get(ROUTES_STORAGE_KEY)).toContain("authorization");
    expect(s.map.get(ROUTES_STORAGE_KEY)).not.toContain("sk-");
  });

  it("returns an empty list when nothing is stored", () => {
    expect(loadRoutes(fakeStorage())).toEqual([]);
  });

  // Storage is shared with the user, other tabs and older versions of this
  // page; corrupt content must not stop the page loading.
  it("returns an empty list rather than throwing on unusable content", () => {
    expect(loadRoutes(fakeStorage("not json"))).toEqual([]);
    expect(loadRoutes(fakeStorage('{"not":"an array"}'))).toEqual([]);
    expect(loadRoutes(fakeStorage('[{"prefix":"/x"}]'))).toEqual([]);
  });

  it("survives a storage that throws", () => {
    const hostile = { getItem: () => { throw new Error("blocked"); } };
    expect(loadRoutes(hostile)).toEqual([]);
  });
});

describe("withSecrets", () => {
  it("merges the in-memory secret into the route's headers", () => {
    const [merged] = withSecrets([ROUTE], new Map([["/openai", "Bearer sk-live"]]));
    expect(merged?.headers).toEqual({ "content-type": "application/json", authorization: "Bearer sk-live" });
  });

  it("omits the secret header entirely when no value was entered", () => {
    const [merged] = withSecrets([ROUTE], new Map());
    expect(merged?.headers).toEqual({ "content-type": "application/json" });
  });

  it("leaves a route with no secret header alone", () => {
    const plain: StoredRoute = { ...ROUTE, secretHeader: null };
    const [merged] = withSecrets([plain], new Map([["/openai", "ignored"]]));
    expect(merged?.headers).toEqual({ "content-type": "application/json" });
  });
});
