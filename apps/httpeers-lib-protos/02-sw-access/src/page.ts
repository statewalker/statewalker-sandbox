/**
 * The page half: register one of the two workers, ask it to verify a token,
 * and record what happened on `window.__result` for the test to read.
 *
 * Registration uses `@statewalker/webrun-http-browser`'s `initServiceWorker`,
 * which resolves only once the worker is ACTIVATED AND CONTROLLING — so a
 * worker that fails to parse fails here, loudly, instead of leaving the page
 * waiting on a message that never comes.
 */
import { initServiceWorker } from "@statewalker/webrun-http-browser";

declare global {
  interface Window {
    __result?: { stage: string; ok: boolean; detail: string };
  }
}

const params = new URLSearchParams(location.search);
const variant = params.get("variant") ?? "naive";
const token = params.get("token") ?? "";
const issuer = params.get("issuer") ?? "";
const sub = params.get("sub") ?? "";

function report(stage: string, ok: boolean, detail: string): void {
  window.__result = { stage, ok, detail };
  const el = document.getElementById("out");
  if (el != null) el.textContent = JSON.stringify(window.__result);
}

async function main(): Promise<void> {
  let worker: ServiceWorker;
  try {
    worker = await initServiceWorker({ swUrl: `/sw-${variant}.js`, type: "module" });
  } catch (error) {
    // The outcome variant A is expected to produce, and the one worth naming
    // precisely: the worker never became controlling.
    report("register", false, String(error));
    return;
  }

  const reply = new Promise<Record<string, unknown>>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("no reply from the worker in 20s")), 20_000);
    navigator.serviceWorker.addEventListener("message", (event: MessageEvent) => {
      clearTimeout(timer);
      resolve(event.data as Record<string, unknown>);
    });
  });

  worker.postMessage({
    kind: "verify",
    token,
    issuer,
    connectionPeer: sub,
    wasmUrl: "/biscuit_bg.wasm",
  });

  try {
    const data = await reply;
    report("verify", data.kind === "verified", JSON.stringify(data));
  } catch (error) {
    report("verify", false, String(error));
  }
}

void main().catch((error: unknown) => report("boot", false, String(error)));
