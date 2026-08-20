/**
 * `assertKeyMatchesPrefix` (`src/browser/edge-guard.ts`) is the one piece
 * of Task 11's browser runtime that is pure logic and needs no browser --
 * everything else in `src/browser/` genuinely needs one and is Task 15's
 * Playwright job (see that task's own report for what it exercises).
 *
 * Deliberately imports `edge-guard.ts` directly, NOT `edge.ts`: `edge.ts`
 * imports `@statewalker/webrun-http-browser/sw`, whose workspace package
 * ships no committed `dist/` (see `edge.ts`'s own doc comment and this
 * task's report) -- this test must keep passing regardless of whether
 * that package has been built in the current checkout.
 */
import { describe, expect, it } from "vitest";
import { assertKeyMatchesPrefix } from "../src/browser/edge-guard.js";

describe("assertKeyMatchesPrefix", () => {
  it("accepts a prefix whose first segment equals the key", () => {
    expect(() => assertKeyMatchesPrefix("mesh", "mesh/")).not.toThrow();
  });

  it("accepts a multi-segment prefix whose first segment equals the key", () => {
    expect(() => assertKeyMatchesPrefix("mesh", "mesh/sub/path/")).not.toThrow();
  });

  // TWO ASSERTIONS CHANGED IN TASK 13 (fix round 1), deliberately: this
  // case used to read "accepts a bare key with no trailing slash", and the
  // multi-segment case above used to pass "mesh/sub/path". Both now throw,
  // because Ruling 58 turned `BrowserPeerHandle.baseUrl`'s trailing slash
  // into a published contract -- `SwHttpRegistration.baseUrl` is
  // `new URL("./" + prefix, rootUrl)`, so a slash-less prefix yields a
  // slash-less baseUrl, and `${baseUrl}${peerId}/search` becomes
  // `/meshPEERID/search`: unroutable, and silently falling through to the
  // origin server. The old assertions were correct for a guard that only
  // policed the FIRST segment; they are wrong for one that has to keep
  // that promise too. Nothing in the app passed a slash-less prefix
  // (`mountEdge` defaults to `${key}/`), so no behaviour changed -- only
  // what the guard will now refuse.
  it("throws on a bare key with no trailing slash", () => {
    expect(() => assertKeyMatchesPrefix("mesh", "mesh")).toThrow(/does not end with/);
  });

  it("throws on a multi-segment prefix with no trailing slash", () => {
    expect(() => assertKeyMatchesPrefix("mesh", "mesh/sub/path")).toThrow(/does not end with/);
  });

  it("the trailing-slash message names the contract it protects, not just the rule", () => {
    // A guard that only says "invalid" sends the next reader to the wrong
    // layer -- the whole point of note 39's remedy.
    expect(() => assertKeyMatchesPrefix("mesh", "mesh")).toThrow(/baseUrl/);
  });

  it("throws when the prefix's first segment differs from the key -- the note 39 trap", () => {
    // Exactly note 39 §3's reproduction: key "peer-under-test", registered under "mesh/".
    expect(() => assertKeyMatchesPrefix("peer-under-test", "mesh/")).toThrow(
      /does not start with adapter key/,
    );
  });

  it("throws when key and prefix are simply different unrelated strings", () => {
    expect(() => assertKeyMatchesPrefix("peer-a", "peer-b")).toThrow();
  });

  it("throws on an empty prefix", () => {
    expect(() => assertKeyMatchesPrefix("mesh", "")).toThrow();
  });

  it("throws when the key is a proper prefix of the first segment but not equal to it", () => {
    // "mesh" must not accidentally match "meshy/..." -- split-on-slash equality, not startsWith.
    expect(() => assertKeyMatchesPrefix("mesh", "meshy/")).toThrow();
  });
});
