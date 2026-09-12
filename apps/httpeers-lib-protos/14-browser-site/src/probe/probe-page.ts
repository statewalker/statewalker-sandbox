/**
 * The probe's page: register the bare worker, start a streaming request,
 * abort it, and ask the worker what it saw.
 */

declare global {
  interface Window {
    __probe?: {
      controlled?: boolean;
      rejected?: boolean;
      seen?: { signal: boolean; cancel: boolean; ticks: number; ended: boolean };
      error?: string;
    };
  }
}

async function main(): Promise<void> {
  const registration = await navigator.serviceWorker.register("./probe-worker.js", {
    scope: "./",
  });
  await navigator.serviceWorker.ready;
  if (navigator.serviceWorker.controller == null) {
    // The worker claims on activate; wait for it rather than racing.
    await new Promise<void>((resolve) => {
      navigator.serviceWorker.addEventListener("controllerchange", () => resolve(), { once: true });
    });
  }
  void registration;

  const controller = new AbortController();
  const pending = fetch("./probe/slow", { signal: controller.signal });
  // Let the worker's producer get going, then walk away mid-stream.
  await new Promise((resolve) => setTimeout(resolve, 300));
  controller.abort();

  let rejected = false;
  try {
    const response = await pending;
    await response.text();
  } catch {
    rejected = true;
  }

  // Give the worker a moment to observe whatever it is going to observe.
  await new Promise((resolve) => setTimeout(resolve, 500));

  const seen = await new Promise<{
    signal: boolean;
    cancel: boolean;
    ticks: number;
    ended: boolean;
  }>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("the worker never reported")), 10_000);
    navigator.serviceWorker.addEventListener(
      "message",
      (event: MessageEvent) => {
        if ((event.data as { type?: string })?.type !== "probe-report") return;
        clearTimeout(timer);
        resolve((event.data as { seen: typeof seen }).seen);
      },
      { once: true },
    );
    navigator.serviceWorker.controller?.postMessage({ type: "probe-report" });
  });

  window.__probe = {
    controlled: navigator.serviceWorker.controller != null,
    rejected,
    seen,
  };
}

void main().catch((error: unknown) => {
  window.__probe = { error: String(error) };
});

export {};
