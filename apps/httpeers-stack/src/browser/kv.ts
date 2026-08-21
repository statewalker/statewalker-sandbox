/**
 * The one asynchronous key/value seam every persistent thing in a page
 * writes through -- IndexedDB in the browser, a `Map` in a Node test.
 *
 * WHY IT IS ITS OWN FILE (Task 28). The seam was invented in
 * `./snapshot-store.ts` for the hub page's snapshot, for a reason that has
 * nothing to do with hubs: `idb-keyval` needs a real IndexedDB, which Node
 * does not have, so every module that persists something would otherwise be
 * untestable below its first storage call. Three modules now want it --
 * that one, `./identity.ts`, and `./mesh-memory.ts` -- and having the two
 * consumer pages reach into the HUB PAGE's module for a generic interface
 * would state a dependency that is not real. Both original names are
 * re-exported from `./snapshot-store.ts`, so nothing that imported them
 * from there had to change.
 *
 * TWO BACKENDS, NOT ONE, AND THE SPLIT IS THE STORED FORMAT. Strings
 * (`AsyncKeyValueBackend`) are what a JSON snapshot wants -- see
 * `./snapshot-store.ts`'s own note on why it stores a string rather than a
 * structured-cloned object. Bytes (`AsyncBytesBackend`) are what an
 * identity key wants: `./identity.ts` has stored raw protobuf `Uint8Array`
 * since Task 24, and re-encoding it as a string now would leave every
 * existing page unable to read the key it already has -- silently founding
 * a different identity on the next load, which for the hub page is a
 * different MESH. The formats stay as they are; the seam accommodates both.
 */
import { del, get, set } from "idb-keyval";

/** Storage for values this app keeps as JSON text. */
export interface AsyncKeyValueBackend {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  del(key: string): Promise<void>;
}

/** Storage for values this app keeps as raw bytes -- today, exactly one: the identity key. */
export interface AsyncBytesBackend {
  get(key: string): Promise<Uint8Array | undefined>;
  set(key: string, value: Uint8Array): Promise<void>;
  del(key: string): Promise<void>;
}

/** The real thing: `idb-keyval`, the same IndexedDB store `@statewalker/webrun-http-browser` already uses. */
export function idbBackend(): AsyncKeyValueBackend {
  return {
    get: (key) => get<string>(key),
    set: (key, value) => set(key, value),
    del: (key) => del(key),
  };
}

/** The same store, for the one value kept as bytes -- see the module comment. */
export function idbBytesBackend(): AsyncBytesBackend {
  return {
    get: (key) => get<Uint8Array>(key),
    set: (key, value) => set(key, value),
    del: (key) => del(key),
  };
}
