/**
 * C0.5 — the five re-checks on `BrowserFilesApi` over the real Origin Private
 * File System, in a real Chromium.
 *
 * This adapter is the one that COMMITS a partial write, which is re-check 1 and
 * the behaviour seven rungs asserted without ever seeing.
 */
import { defineRechecks } from "./support/recheck-suite.js";
import { opfsFilesFactory, opfsFixture } from "./support/opfs-fixture.js";

defineRechecks({ makeFixture: opfsFixture, factory: opfsFilesFactory });
