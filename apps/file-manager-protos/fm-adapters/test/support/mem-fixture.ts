/**
 * The CONTROL fixture.
 *
 * Not a fourth adapter under test: it is how the shared suite proves it is a
 * faithful port rather than a rewrite. Every assertion in `core-suite.ts` has to
 * hold on `MemFilesApi`, which is what the adopted P2–P6 suites ran on, or the
 * port changed the specification on its way across.
 *
 * `revoke()` throws `unsupported`, and the suite asserts that `mem` cannot
 * revoke rather than skipping the case — `caps.canRevokeRootMidFlight` is the
 * row that says so.
 */

import { MemFilesApi } from "@statewalker/webrun-files-mem";
import type { AdapterFactory } from "../../../fm-core/src/storage-registry.js";
import { capabilitiesOf } from "../../src/capabilities.js";
import type { AdapterFixture, StorageFixture } from "./adapter-fixture.js";

export const memFilesFactory: AdapterFactory = (uri, options) => {
  const api = options.api as MemFilesApi | undefined;
  if (!api) throw new Error(`${uri}: no api in options`);
  return api;
};

export function memFixture(): AdapterFixture {
  let revoked = false;
  return {
    caps: capabilitiesOf("mem"),
    async storage(label: string): Promise<StorageFixture> {
      const api = new MemFilesApi();
      const secretKey = `mem.root:${label}`;
      return {
        uri: `mem://${label}`,
        api,
        secretKey,
        configOptions: { api: { $secret: secretKey } },
        rootSecret: async () => {
          // A Map has nothing to revoke. The fixture reports the platform's
          // answer, which is "this cannot happen here", not a simulated failure.
          if (revoked) throw new Error("mem storage cannot be revoked");
          return api;
        },
        async revoke() {
          revoked = true;
        },
      };
    },
    async cleanup() {},
  };
}
