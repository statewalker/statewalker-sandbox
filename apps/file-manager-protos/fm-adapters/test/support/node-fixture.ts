/**
 * The Node filesystem fixture — `NodeFilesApi` over a real directory under
 * `os.tmpdir()`.
 *
 * THIS IS THE FIXTURE THAT CAN DENY A WRITE. `chmod 0o500` on a storage's root
 * makes `fs.writeFile` raise a real `EACCES`, which is the only way anything in
 * this app has ever seen "permission denied in the middle of a job". OPFS cannot
 * produce it; mem cannot produce it. See `ADAPTERS.md`.
 *
 * It must therefore NOT run as root — root ignores the permission bits and every
 * denial test would pass vacuously, which is the exact shape of a false green.
 * `assertNotRoot` fails loudly instead.
 */

import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeFilesApi } from "@statewalker/webrun-files-node";
import { capabilitiesOf } from "../../src/capabilities.js";
import { nodeRootProvider } from "../../src/node-fs.js";
import type { AdapterFixture, StorageFixture } from "./adapter-fixture.js";

export { nodeFilesFactory } from "../../src/node-fs.js";

/**
 * `chmod` is advisory for uid 0, so a denial suite under root is a suite that
 * cannot fail. Checked once, as an assertion rather than a warning.
 */
export function isRoot(): boolean {
  return typeof process.getuid === "function" && process.getuid() === 0;
}

export function nodeFixture(): AdapterFixture {
  const created: string[] = [];
  return {
    caps: capabilitiesOf("node"),
    async storage(label: string): Promise<StorageFixture> {
      const dir = await mkdtemp(join(tmpdir(), `fm-${label}-`));
      created.push(dir);
      const secretKey = `node.root:${dir}`;
      return {
        uri: `file://${dir}`,
        api: new NodeFilesApi({ rootDir: dir }),
        secretKey,
        configOptions: { rootDir: { $secret: secretKey } },
        rootSecret: nodeRootProvider(dir),
        async revoke() {
          // Removed outright: the directory a live NodeFilesApi is rooted at is
          // gone, and `access()` in the provider fails with a real ENOENT.
          await rm(dir, { recursive: true, force: true });
        },
      };
    },
    async denyWrites(storage: StorageFixture) {
      // r-x: the directory is still listable and its existing files readable, so
      // the job gets as far as a write and then is refused — which is what
      // "denial MID-JOB" means, as distinct from a storage that never opened.
      await chmod(storage.uri.replace("file://", ""), 0o500);
    },
    async allowWrites(storage: StorageFixture) {
      await chmod(storage.uri.replace("file://", ""), 0o700);
    },
    async cleanup() {
      for (const dir of created.splice(0)) {
        await chmod(dir, 0o700).catch(() => undefined);
        await rm(dir, { recursive: true, force: true });
      }
    },
  };
}
