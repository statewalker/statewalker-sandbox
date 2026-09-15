/**
 * THE swap point. The app imports its signals from `@todo/signals`, which is
 * this file; this one line chooses the library. `preact.ts` is the other
 * implementation, and the ladder runs on both (vitest.config.ts).
 */
export * from "./alien.js";
