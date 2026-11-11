/// <reference lib="webworker" />
/**
 * Minimal `document` for libraries that expect a window (OpenCV.js reads it
 * while loading; gutenye's browser backend creates canvases with
 * document.createElement). Imported first by `paddle.worker.ts`: ES imports
 * run before the importing module's body.
 */
(globalThis as { document?: unknown }).document ??= {
  currentScript: null,
  // Lookups find nothing: there is no DOM here.
  querySelector: () => null,
  querySelectorAll: () => [],
  getElementById: () => null,
  getElementsByTagName: () => [],
  addEventListener: () => {},
  removeEventListener: () => {},
  createElement: (tag: string) => {
    if (tag !== "canvas") throw new Error(`no <${tag}> in a worker`);
    return new OffscreenCanvas(1, 1);
  },
};
