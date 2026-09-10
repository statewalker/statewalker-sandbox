/**
 * C0.5 — the five re-checks on `NodeFilesApi` over a real directory.
 *
 * This adapter is the one that can deny a write, which is re-check 2 and the one
 * neither of the other two can produce at all.
 */

import { nodeFilesFactory, nodeFixture } from "./support/node-fixture.js";
import { defineRechecks } from "./support/recheck-suite.js";

defineRechecks({ makeFixture: nodeFixture, factory: nodeFilesFactory });
