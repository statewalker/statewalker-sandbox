/** X5 — SQL backend over statewalker-db's Db; a batch is one inTransaction. Stub in red. */
import type { Db } from "@statewalker/db-api";
import type { RefDb } from "./ref-db.js";

export async function sqlRefDb(_db: Db, _prefix = "refdb_"): Promise<RefDb> {
  throw new Error("not implemented");
}
