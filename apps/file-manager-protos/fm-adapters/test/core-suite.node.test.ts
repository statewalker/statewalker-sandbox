/**
 * C0.5 — the ported core suite on `NodeFilesApi` over a real directory.
 *
 * Real `fs`, real latency, real permission bits. The first of the two non-mem
 * adapters C0.5 is done when.
 */
import { expect, it } from "vitest";
import { defineCoreSuite } from "./support/core-suite.js";
import { isRoot, nodeFilesFactory, nodeFixture } from "./support/node-fixture.js";

/**
 * Under uid 0 every `chmod` in this suite is advisory and every denial test
 * passes without denying anything. Asserted rather than warned about: a suite
 * that cannot fail is the failure.
 */
it("is not running as root, or the permission cases are vacuous", () => {
  expect(isRoot()).toBe(false);
});

defineCoreSuite({ makeFixture: nodeFixture, factory: nodeFilesFactory });
