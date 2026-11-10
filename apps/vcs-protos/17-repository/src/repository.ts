/**
 * Both backends (import `files-repository.ts` or `sql-repository.ts` alone to keep the other's
 * code out of a bundle).
 */

export { filesRepository } from "./files-repository.js";
export type { Repository, StoreOptions } from "./object-store.js";
export { sqlRepository } from "./sql-repository.js";
