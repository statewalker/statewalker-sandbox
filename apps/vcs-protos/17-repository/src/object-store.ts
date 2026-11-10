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
  /** Installs a received pack (a thin pack is completed from this store). */
  installPack(source: AsyncIterable<Uint8Array>): Promise<{ packId: string; count: number }>;
}
