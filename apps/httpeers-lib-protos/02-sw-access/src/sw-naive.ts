/**
 * VARIANT A — the obvious thing: import the token code into the worker and
 * let the bundler deal with the wasm.
 *
 * The dispatcher is `@statewalker/webrun-http-browser`'s, unchanged, exactly
 * as `apps/httpeers-stack/src/pages/app/sw.ts` uses it — this variant differs
 * from the shipping worker in ONE respect, the added `verifyToken` import,
 * so that whatever happens is attributable to that import alone.
 */
import "@statewalker/webrun-http-browser/sw-worker";
import { verifyToken } from "@statewalker/httpeers.core/tokens";
import { ANONYMOUS } from "@statewalker/httpeers.core/types";

self.addEventListener("message", (event: Event) => {
  const { data, source } = event as ExtendableMessageEvent;
  if (data?.kind !== "verify") return;
  void (async (): Promise<void> => {
    try {
      const claims = await verifyToken(data.token, {
        issuer: data.issuer,
        connectionPeer: data.connectionPeer ?? ANONYMOUS,
      });
      source?.postMessage({ kind: "verified", sub: claims.sub, roles: claims.roles });
    } catch (error) {
      source?.postMessage({ kind: "failed", message: String(error) });
    }
  })();
});
