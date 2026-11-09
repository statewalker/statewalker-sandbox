/// <reference lib="webworker" />
// The origin's router: every request outside /__cellb/ goes to the platform, URL unchanged.
import { installProjectRouter } from "@statewalker/cellb/browser";

declare const self: ServiceWorkerGlobalScope;
self.addEventListener("install", () => void self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
installProjectRouter(self, {
  basePath: "/__cellb/projects/",
  root: { name: "platform", passthrough: ["/__cellb/", "/cellb-sw.js"], hostPage: "/__cellb/" },
});
