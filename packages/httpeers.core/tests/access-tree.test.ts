/**
 * A-1: does the walked `.access` tree reproduce the rules-array decisions?
 *
 * Goal: swap the array for a tree with NO behaviour change, then gain the
 * things a tree can express that an array cannot.
 *
 * The equivalence table at the bottom is the load-bearing part. The rest
 * documents what the tree buys.
 *
 * A-3 changed what `anyOf` names — capabilities, not roles — so `decide`
 * below threads a vocabulary through `resolveAccess`. `DEFAULT_VOCABULARY`
 * is used throughout; ad-hoc trees that need to distinguish "member-level"
 * from "admin-only" access use its `std:mesh.read` / `std:mesh.admin`
 * capabilities rather than the role names `member` / `admin` themselves —
 * writing a role name into `anyOf` would now mean something different (see
 * `vocabulary.test.ts`'s "catches a ROLE name used where a capability
 * belongs").
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_ACCESS_TREE, ancestors, resolveAccess, withAccessTree } from "../src/access-tree.js";
import type { AccessTree } from "../src/access-tree.js";
import { cacheClaims } from "../src/peer-context.js";
import type { MeshClaims } from "../src/types.js";
import { DEFAULT_VOCABULARY } from "../src/vocabulary.js";

const claims = (...roles: string[]): MeshClaims => ({
  sub: "peerA",
  iss: "hub",
  mesh: "hub",
  roles,
  iat: Date.now(),
  exp: Date.now() + 60_000,
});
const member = claims("member");
const admin = claims("admin");

const decide = (tree: AccessTree, path: string, c: MeshClaims | null, method = "GET") =>
  resolveAccess(tree, path, method, c, DEFAULT_VOCABULARY);

describe("A-1: ancestor walk", () => {
  it("lists directory prefixes shallowest first, excluding the resource", () => {
    expect(ancestors("/a/b/c")).toEqual(["/", "/a/", "/a/b/"]);
    expect(ancestors("/x")).toEqual(["/"]);
    expect(ancestors("/")).toEqual(["/"]);
  });
});

describe("A-1: deny by default", () => {
  it("an empty tree denies everything", () => {
    expect(decide({}, "/anything", admin).allowed).toBe(false);
  });

  it("a root deny with no grant below denies", () => {
    expect(decide({ "/": { anyOf: [] } }, "/x", admin).allowed).toBe(false);
  });

  it("a path with no governing entry is denied even for admin", () => {
    expect(decide({ "/a/": { anyOf: ["std:mesh.admin"] } }, "/b/x", admin).allowed).toBe(false);
  });
});

describe("A-1: root-to-leaf override", () => {
  // A-3: 'std:mesh.read' (member and admin both hold it) stands in for the
  // old 'member' literal; 'std:mesh.admin' (admin only) stands in for 'admin'.
  const tree: AccessTree = {
    "/": { anyOf: [] },
    "/docs/": { anyOf: ["std:mesh.read"] },
    "/docs/secret/": { anyOf: ["std:mesh.admin"] },
  };

  it("a deeper entry overrides a shallower one", () => {
    expect(decide(tree, "/docs/readme", member).allowed).toBe(true);
    expect(decide(tree, "/docs/secret/keys", member).allowed).toBe(false);
    expect(decide(tree, "/docs/secret/keys", admin).allowed).toBe(true);
  });

  it("reports which directory governed the decision", () => {
    expect(decide(tree, "/docs/secret/keys", admin).source).toBe("/docs/secret/");
    expect(decide(tree, "/docs/readme", member).source).toBe("/docs/");
    expect(decide(tree, "/elsewhere", member).source).toBe("/");
  });

  it("a deeper entry can WIDEN as well as narrow", () => {
    // Not expressible cleanly with longest-prefix-plus-roles; the tree makes
    // it obvious that /docs/public/ is deliberately more open than /docs/.
    const t: AccessTree = { ...tree, "/docs/public/": { public: true } };
    expect(decide(t, "/docs/public/index.html", null).allowed).toBe(true);
    expect(decide(t, "/docs/readme", null).allowed).toBe(false);
  });
});

describe("A-1: per-method policy", () => {
  // The array had NO way to say this. Every write-protected resource would
  // have needed a second prefix and a naming convention.
  const tree: AccessTree = {
    "/": { anyOf: [] },
    "/notes/": {
      anyOf: ["std:mesh.read"],
      methods: { PUT: { anyOf: ["std:mesh.admin"] }, DELETE: { anyOf: [] } },
    },
  };

  it("read is allowed to members, write only to admins", () => {
    expect(decide(tree, "/notes/x", member, "GET").allowed).toBe(true);
    expect(decide(tree, "/notes/x", member, "PUT").allowed).toBe(false);
    expect(decide(tree, "/notes/x", admin, "PUT").allowed).toBe(true);
  });

  it("a method can be denied to everyone", () => {
    expect(decide(tree, "/notes/x", admin, "DELETE").allowed).toBe(false);
  });

  it("an unlisted method falls back to the directory entry", () => {
    expect(decide(tree, "/notes/x", member, "POST").allowed).toBe(true);
  });
});

describe("A-1: public paths need no token", () => {
  const tree: AccessTree = { "/": { anyOf: [] }, "/pub/": { public: true } };

  it("grants with no claims at all", () => {
    expect(decide(tree, "/pub/x", null).allowed).toBe(true);
  });

  it("still denies elsewhere", () => {
    expect(decide(tree, "/other", null).allowed).toBe(false);
  });
});

describe("A-1: equivalence with the rules array it replaces", () => {
  // The decisions the DEFAULT_ACCESS_RULES array produced, as a table.
  // This is the acceptance criterion for the swap — and, since A-3, for the
  // capability switch too: THESE ELEVEN CASES ARE UNCHANGED FROM BEFORE
  // THAT SWITCH. That is the evidence it preserved behaviour; see
  // CHANGES-v0.9.0.txt.
  const cases: Array<[string, MeshClaims | null, boolean]> = [
    ["/.well-known/mesh", member, true],
    ["/.well-known/mesh", admin, true],
    ["/.well-known/mesh", null, false],
    ["/.well-known/capabilities", member, true],
    ["/test/whoami", member, true],
    ["/test/echo", admin, true],
    ["/test/whoami", null, false],
    ["/admin/invitations", admin, true],
    ["/admin/invitations", member, false],
    ["/nothing/here", admin, false],
    ["/nothing/here", member, false],
  ];

  for (const [path, c, expected] of cases) {
    const who = c == null ? "anonymous" : c.roles.join("+");
    it(`${path} for ${who} → ${expected ? "allow" : "deny"}`, () => {
      expect(decide(DEFAULT_ACCESS_TREE, path, c).allowed).toBe(expected);
    });
  }
});

/**
 * Not promoted from the archive — `withAccessTree` is a MIDDLEWARE, and
 * neither archived test file exercises its returned handler (folder 33
 * predates the vocabulary and never called it; folder 37's
 * `vocabulary.test.ts` only exercises the constructor-throw half). Written
 * fresh to cover the dispatch half: it reads claims from the request-bound
 * cache (`lookupClaims`, via `peer-context.ts`), not by calling `getClaims`
 * itself — that verification already happened in the binding middleware
 * (Task 3), so tests here populate the cache directly with `cacheClaims`
 * rather than minting a real token.
 */
describe("A-1: withAccessTree as middleware", () => {
  const tree: AccessTree = {
    "/": { anyOf: [] },
    "/notes/": { anyOf: ["std:mesh.read"] },
    "/admin/": { anyOf: ["std:mesh.admin"] },
    "/pub/": { public: true },
  };

  function subject(usesTransportIdentity: () => boolean = () => false) {
    let reached = false;
    const handler = withAccessTree({
      tree,
      vocabulary: DEFAULT_VOCABULARY,
      usesTransportIdentity: async () => usesTransportIdentity(),
    })(async () => {
      reached = true;
      return new Response("ok");
    });
    return { handler, reached: () => reached };
  }

  it("bypasses tree policy entirely on a bootstrap (transport-identity) request", async () => {
    const s = subject(() => true);
    const req = new Request("http://peer/admin/x"); // no claims cached at all
    const res = await s.handler(req);
    expect(res.status).toBe(200);
    expect(s.reached()).toBe(true);
  });

  it("admits when the cached claims grant the required capability", async () => {
    const s = subject();
    const req = new Request("http://peer/notes/x");
    cacheClaims(req, member);
    const res = await s.handler(req);
    expect(res.status).toBe(200);
    expect(s.reached()).toBe(true);
  });

  it("denies with 403 when cached claims are present but insufficient", async () => {
    const s = subject();
    const req = new Request("http://peer/admin/x");
    cacheClaims(req, member);
    const res = await s.handler(req);
    expect(res.status).toBe(403);
    expect(s.reached()).toBe(false);
    expect(await res.json()).toEqual({ error: "requires one of: std:mesh.admin" });
  });

  it("denies with 401 when no claims were ever cached for a path that requires them", async () => {
    const s = subject();
    const req = new Request("http://peer/notes/x"); // cacheClaims never called
    const res = await s.handler(req);
    expect(res.status).toBe(401);
    expect(s.reached()).toBe(false);
    expect(await res.json()).toEqual({ error: "membership token required" });
  });

  it("admits a public path with no claims cached at all", async () => {
    const s = subject();
    const req = new Request("http://peer/pub/x");
    const res = await s.handler(req);
    expect(res.status).toBe(200);
    expect(s.reached()).toBe(true);
  });
});
