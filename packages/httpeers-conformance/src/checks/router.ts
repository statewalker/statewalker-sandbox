/** Block R — the router and its mount table. */
import { NotImplemented, NotTestable, type Check, type FetchHandler, type Implementation } from "../types.js";

const H = (name: string): FetchHandler => async () => new Response(name);
/** Which handler ran — the observable, rather than a prefix an adapter might invent. */
const who = async (h: FetchHandler | null): Promise<string | null> =>
  h ? await (await h(new Request("http://x/"))).text() : null;
const mounts = (impl: Implementation) => {
  if (!impl.mounts) throw new NotImplemented("no `mounts` capability");
  return impl.mounts;
};
const assert = (cond: unknown, msg: string): void => {
  if (!cond) throw new Error(msg);
};
/** Build and expect a throw; returns the error message. */
function expectThrow(build: () => unknown, what: string): string {
  try {
    build();
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  throw new Error(`expected ${what} to throw; it was accepted`);
}

export const ROUTER_CHECKS: Record<string, Check | { skip: string }> = {
  "R-01": async (impl) => {
    const m = mounts(impl);
    // Same definitions, two insertion orders. The result must not depend on order.
    const a = m.build({ "/a": H("short"), "/a/b": H("long") });
    const b = m.build({ "/a/b": H("long"), "/a": H("short") });
    for (const t of [a, b]) {
      assert(await who(t.resolve("/a/b/c")) === "long", "longest prefix did not win");
      assert(await who(t.resolve("/a/x")) === "short", "shorter prefix did not match its own path");
    }
  },

  "R-02": async (impl) => {
    const t = mounts(impl).build({ "/files": H("files") });
    assert(await who(t.resolve("/files/x")) === "files", "/files did not match its own subtree");
    assert(t.resolve("/filesystem") === null, "/files swallowed /filesystem — segment boundary not respected");
  },

  "R-03": async (impl) => {
    const t = mounts(impl).build({ "/": H("root"), "/api": H("api") });
    assert(await who(t.resolve("/anything")) === "root", "root mount did not catch an unclaimed path");
    assert(await who(t.resolve("/api/x")) === "api", "root mount beat a more specific mount");
  },

  "R-04": (impl) => {
    const t = mounts(impl).build({ "/api": H("api") });
    assert(t.resolve("/nope") === null, "an unmatched path resolved to a handler");
  },

  "R-05": (impl) => {
    const m = mounts(impl);
    expectThrow(() => m.build({ "/api/": H("x") }), "a trailing-slash prefix");
  },

  "R-06": (impl) => {
    const m = mounts(impl);
    expectThrow(() => m.build({ "/api": H("a"), "/api/": H("b") }), "two prefixes matching at equal depth");
  },

  "R-07": (impl) => {
    const m = mounts(impl);
    // TWO independent conflicts. A message naming only one is the defect A-3 and
    // note 39 both refused: report every problem, not the first.
    const msg = expectThrow(
      () => m.build({ "/a/": H("a"), "/b/": H("b") }),
      "a table with two conflicting prefixes",
    );
    assert(msg.includes("/a"), `error did not name /a: ${msg}`);
    assert(msg.includes("/b"), `error named only the first conflict: ${msg}`);
  },

  "R-08": { skip: "needs a forwarding-router capability with an observable dial counter; this harness models mount tables only" },
  "R-09": { skip: "needs a forwarding-router capability; see R-08" },
  "R-10": { skip: "needs a forwarding-router capability carrying a hop counter; see R-08" },
  "R-11": { skip: "needs a forwarding-router capability; see R-08" },
  "R-12": { skip: "needs a forwarding-router capability; see R-08" },
  "R-13": { skip: "needs a live peer whose configuration can be swapped under in-flight requests" },

  "R-14": () => {
    // Static, and deliberately not delegated to the implementation: the claim is
    // about a dependency graph, so asking the package about itself would prove
    // nothing. Resolved by the adapter module in `adapters/`.
    throw new NotTestable(
      "asserted by `tests/dependency-graph.test.ts`, which reads the package manifest rather than calling the implementation",
    );
  },
};
