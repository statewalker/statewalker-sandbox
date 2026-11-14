/** The one object-store interface the command layer sees. */
export type ObjectType = "blob" | "tree" | "commit" | "tag";
export interface StoredObject {
  type: ObjectType;
  size: number;
  content: AsyncIterable<Uint8Array>;
}
export interface ObjectStore {
  /** Stores a loose object; returns git's id. */
  put(type: ObjectType, content: Uint8Array): Promise<string>;
  get(oid: string, opts?: { verify?: boolean }): Promise<StoredObject | undefined>;
  has(oid: string): Promise<boolean>;
  /** Every object id once (packs and loose objects). */
  list(): AsyncIterable<string>;
  /**
   * The object's entry as a pack stores it, if it is in a pack (X6d: copied as is when exporting).
   * Absent for loose objects.
   */
  packedEntry?(
    oid: string,
  ): Promise<import("../../13-pack-reader/src/pack-reader.js").PackedEntry | undefined>;
  /** Installs a received pack (a thin pack is completed from this store). */
  installPack(source: AsyncIterable<Uint8Array>): Promise<{ packId: string; count: number }>;
  /** What gc (X18) needs: the store's inventory and removal. */
  gc?: GcAccess;
}

/** The store's inventory and removal, for gc (X18). */
export interface GcAccess {
  /** a FilesApi and a directory for gc's own files (ledger, leases, state) */
  files: import("@statewalker/webrun-files").FilesApi;
  dir: string;
  /** the repository's root on `files` (git files: the .git directory: worktrees, index, shallow) */
  root: string;
  /** the installed packs: id and object ids */
  packs(): { packId: string; ids(): Iterable<string> }[];
  /** packs protected by a `.keep` file (git's: never repacked away) */
  keptPacks(): Promise<Set<string>>;
  /** loose object ids */
  loose(): AsyncIterable<string>;
  removeLoose(oid: string): Promise<void>;
  /** re-reads the pack directory (another handle may have changed it) */
  refresh(): Promise<void>;
  /** deletes the packs (idx first, then pack) and reopens the pack database */
  removePacks(packIds: string[]): Promise<void>;
}

/** A repository is an object store and X5's ref store (refs are git's, on every backend). */
export interface Repository {
  objects: ObjectStore;
  refs: import("../../10-ref-transactions/src/ref-db.js").RefDb;
}

export interface StoreOptions {
  /** Largest object accepted: pack entries, and a thin pack's bases taken from this store. Default 1 GiB. */
  maxObjectSize?: number;
  /** Largest pack accepted while it is received. Default: no limit (git's receive.maxInputSize). */
  maxPackSize?: number;
}
