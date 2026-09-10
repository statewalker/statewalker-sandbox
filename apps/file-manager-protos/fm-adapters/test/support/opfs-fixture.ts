/**
 * The OPFS fixture — `BrowserFilesApi` over a real Origin Private File System in
 * a real Chromium.
 *
 * OPFS IS ONE ORIGIN, SHARED BY EVERY TEST FILE in the browser project, so every
 * storage gets a directory name unique to the run. Two files colliding on
 * `/src` would be a cross-test failure that looks like a logic bug, which is the
 * most expensive kind to read.
 *
 * `revoke()` removes the storage's directory from OPFS. That is a REAL
 * revocation of a real `FileSystemDirectoryHandle`: every later call on the
 * handle already held raises `NotFoundError`, and the next resolution through
 * `opfsDirectoryProvider` (which deliberately does not create) fails at
 * `acquire()`. Nothing here simulates anything.
 *
 * `denyWrites` is ABSENT, and that absence is the finding, not an omission: the
 * Origin Private File System has no per-directory permission model and its root
 * grant is not narrowable from script. `caps.canDenyWriteMidJob` is `false` for
 * `opfs` and the suite asserts exactly that.
 */

import { capabilitiesOf } from "../../src/capabilities.js";
import { browserFilesFactory, opfsDirectoryProvider, removeOpfsDirectory } from "../../src/opfs.js";
import type { AdapterFixture, StorageFixture } from "./adapter-fixture.js";

export { browserFilesFactory as opfsFilesFactory };

let counter = 0;
const runId = `r${Date.now().toString(36)}`;

export function opfsFixture(): AdapterFixture {
  const created: string[] = [];
  return {
    caps: capabilitiesOf("opfs"),
    async storage(label: string): Promise<StorageFixture> {
      const name = `fm-${runId}-${label}-${++counter}`;
      created.push(name);
      const root = await navigator.storage.getDirectory();
      // Created once, here. The provider the registry uses does NOT create, so a
      // removed directory is reported rather than silently replaced by an empty one.
      const handle = await root.getDirectoryHandle(name, { create: true });
      const secretKey = `opfs.root:${name}`;
      const { BrowserFilesApi } = await import("@statewalker/webrun-files-browser");
      return {
        uri: `opfs://${name}`,
        api: new BrowserFilesApi({ rootHandle: handle }),
        secretKey,
        configOptions: { rootHandle: { $secret: secretKey } },
        rootSecret: opfsDirectoryProvider(name),
        async revoke() {
          await removeOpfsDirectory(name);
        },
      };
    },
    async cleanup() {
      for (const name of created.splice(0)) await removeOpfsDirectory(name);
    },
  };
}
