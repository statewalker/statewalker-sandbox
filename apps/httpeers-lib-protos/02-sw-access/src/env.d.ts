/**
 * Two declarations the worker variants need, and nothing more.
 *
 * `lib: ["WebWorker"]` is NOT added to the tsconfig: it collides with the DOM
 * lib the page half needs, and the only worker type used here is the message
 * event. Declaring that one shape locally is smaller than splitting the
 * project into two compilations for it.
 */

/// <reference types="vite/client" />

/** `biscuit_bg.js` is a wasm-bindgen output with no `.d.ts` of its own. */
declare module "*/biscuit_bg.js";

/** The subset of the ServiceWorker message event these workers touch. */
interface ExtendableMessageEvent extends Event {
  // biome-ignore lint/suspicious/noExplicitAny: a postMessage payload is untyped by construction.
  readonly data: any;
  readonly source: { postMessage(message: unknown): void } | null;
}
