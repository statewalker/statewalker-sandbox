/**
 * A `SecretStore` over a map of ASYNC PROVIDERS.
 *
 * P2's store is `get(key): Promise<unknown | undefined>` and its two documented
 * behaviours are both load-bearing here: a resolved value never reaches the
 * config object, and `undefined` means "missing credential" and registers the
 * storage as failed. A provider that THROWS is the third case, and P2 already
 * handles it — `_resolveOptions` is inside `acquire`'s try, so the storage is
 * recorded `failed` with the thrown reason. That is the path a revoked OPFS
 * handle and a `chmod`-ed directory both take.
 *
 * Deliberately pure: no DOM, no `node:`. The providers carry the platform.
 */

import type { SecretStore } from "../../fm-core/src/storage-registry.js";

export type SecretProvider = () => Promise<unknown>;

export function providerSecrets(providers: Record<string, SecretProvider>): SecretStore {
  return {
    async get(key) {
      const provider = providers[key];
      if (!provider) return undefined;
      return provider();
    },
  };
}
