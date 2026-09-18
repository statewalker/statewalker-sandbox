/**
 * The model kit's reactive surface. In P4 the substrate is the KERNEL's (`@kernel` reactive.ts,
 * shared by every bundle); this module only re-exports it so the kit and `*.model.ts` files read
 * as in P0.
 */
export { batch, computed, effect, type Signal, signal, untracked } from "@kernel";
export type Read<T> = () => T;
