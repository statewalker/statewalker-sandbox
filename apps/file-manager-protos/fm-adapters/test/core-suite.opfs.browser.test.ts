/**
 * C0.5 — the ported core suite on `BrowserFilesApi` over the real Origin Private
 * File System, in a real Chromium.
 *
 * The second of the two non-mem adapters C0.5 is done when, and the one that is
 * the actual File System Access API: `FileSystemDirectoryHandle`,
 * `createWritable()`, `removeEntry()`, native `move()`. A user-PICKED root is the
 * same class over a different handle; what that root adds, and why it is not
 * reachable from here, is in `ADAPTERS.md`.
 */
import { defineCoreSuite } from "./support/core-suite.js";
import { opfsFilesFactory, opfsFixture } from "./support/opfs-fixture.js";

defineCoreSuite({ makeFixture: opfsFixture, factory: opfsFilesFactory });
