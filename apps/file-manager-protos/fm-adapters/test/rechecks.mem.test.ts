/**
 * C0.5 — the five re-checks on `MemFilesApi`, the CONTROL.
 *
 * Every capability row mem is `false` for is asserted false HERE, which is what
 * turns "mem hid these three behaviours" from a claim in a note into a fact the
 * suite checks. Two of these cases assert that mem cannot do the thing, and that
 * is the finding rather than a skip.
 */
import { defineRechecks } from "./support/recheck-suite.js";
import { memFilesFactory, memFixture } from "./support/mem-fixture.js";

defineRechecks({ makeFixture: memFixture, factory: memFilesFactory });
