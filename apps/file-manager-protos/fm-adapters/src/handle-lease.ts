/**
 * §6.6 — bookkeeping is synchronous even when construction is not.
 *
 * `StorageRegistry.reserve()` already pins a REFCOUNT before its first await.
 * This is the other half of the same rule, for the resource the work order
 * names explicitly: a File System Access handle, whose acquisition is
 * genuinely asynchronous (`navigator.storage.getDirectory()`, then a walk down
 * to the storage's own directory, then an accessibility check).
 *
 * The failure mode, which the refcount split does NOT cover: a lease that
 * resolved a handle and then failed its accessibility check leaves a live
 * handle with nothing holding it. A later `acquire()` of the same storage then
 * sees a non-empty lease table and concludes the handle is in use. "Release on
 * failure" is the third clause of §6.6 and it is the one that needs code.
 *
 * Pure by construction — no DOM, no `FileSystemHandle`, nothing browser-shaped.
 * It is the generic shape of the rule, and `opfs.ts` is one user of it.
 */

export interface Lease<T> {
  /** Keys currently pinned. A failed acquisition must leave this unchanged. */
  readonly pinned: ReadonlySet<string>;
  /**
   * Pins `key` SYNCHRONOUSLY, then resolves the resource.
   *
   * If `resolve` rejects, the pin is released before the rejection propagates,
   * so a caller that retries starts from the same state it started from the
   * first time. The pin exists during the await precisely so a concurrent
   * release cannot dispose the resource out from under the resolution.
   */
  acquire(key: string, resolve: () => Promise<T>): Promise<T>;
  /** Releases one pin. Unknown key is a no-op, never a decrement. */
  release(key: string): void;
}

export function createLease<T>(): Lease<T> {
  const counts = new Map<string, number>();

  const pin = (key: string) => counts.set(key, (counts.get(key) ?? 0) + 1);
  const unpin = (key: string) => {
    const n = counts.get(key);
    if (n === undefined) return;
    if (n <= 1) counts.delete(key);
    else counts.set(key, n - 1);
  };

  return {
    get pinned() {
      return new Set(counts.keys());
    },
    async acquire(key, resolve) {
      // Synchronous, before the first await. Everything after this line can be
      // interleaved with another holder's release; nothing before it can.
      pin(key);
      try {
        return await resolve();
      } catch (err) {
        unpin(key);
        throw err;
      }
    },
    release(key) {
      unpin(key);
    },
  };
}
