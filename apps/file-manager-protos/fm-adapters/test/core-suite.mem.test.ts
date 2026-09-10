/**
 * C0.5 — the ported core suite on `MemFilesApi`, the CONTROL.
 *
 * This file exists so the claim "the core suites pass unchanged against two
 * non-mem adapters" can be checked rather than believed. If the port had
 * weakened an assertion on its way out of `test/p2…p6-*.test.ts`, the weakened
 * form would pass here too and nothing would say so — so the guard is not this
 * file alone, it is this file plus the adopted suites still running beside it at
 * their original 124. Both must stay green, and they assert the same things
 * about the same code.
 */
import { defineCoreSuite } from "./support/core-suite.js";
import { memFilesFactory, memFixture } from "./support/mem-fixture.js";

defineCoreSuite({ makeFixture: memFixture, factory: memFilesFactory });
