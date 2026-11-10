/** X3a — webrun-storage KvStore over statewalker-db Db, cas as one statement. STUB (red phase). */
import type { Db } from "@statewalker/db-api";
import type { KvStore } from "@statewalker/webrun-storage";

export async function sqlKvStore(_db: Db, _table = "kv"): Promise<KvStore> {
  throw new Error("not implemented");
}
