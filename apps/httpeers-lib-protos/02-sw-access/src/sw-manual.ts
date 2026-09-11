/**
 * VARIANT B — the same worker, with `@biscuit-auth/biscuit-wasm` aliased to
 * `./biscuit-shim.ts` so the wasm is instantiated from bytes inside an async
 * function instead of behind a top-level await.
 *
 * The dispatcher is still webrun-http-browser's, so this also shows whether
 * the two can share one worker.
 */
import "@statewalker/webrun-http-browser/sw-worker";
import { verifyToken } from "@statewalker/httpeers.core/tokens";
import { ANONYMOUS } from "@statewalker/httpeers.core/types";
import { initBiscuit } from "./biscuit-shim.js";

self.addEventListener("message", (event: Event) => {
  const { data, source } = event as ExtendableMessageEvent;
  if (data?.kind !== "verify") return;
  void (async (): Promise<void> => {
    try {
      // The seam in use: nothing has touched the wasm until this line.
      await initBiscuit(data.wasmUrl);
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
