/**
 * THE swap point. The model implementations import their signals as `@sys/signals`, which is
 * this file; this one line chooses the library. `alien.ts` is the only
 * implementation this app ships.
 */
export * from "./alien.js";
