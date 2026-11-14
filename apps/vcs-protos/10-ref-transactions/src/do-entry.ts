/** workerd: runs the X5 contract inside a SQLite-backed Durable Object (SQL and KV backends). */
import { newDoSqliteDb } from "@statewalker/db-sqlite-do";
import { sqlKvStore } from "../../08-sqlite-kv-cas/src/sql-kv-store.js";
import { kvRefDb } from "./kv-ref-db.js";
import { runRefContract } from "./ref-contract.js";
import { sqlRefDb } from "./sql-ref-db.js";

export class RefsDo {
  private n = 0;
  private db: ReturnType<typeof newDoSqliteDb>;
  constructor(ctx: { storage: Parameters<typeof newDoSqliteDb>[0] }) {
    this.db = newDoSqliteDb(ctx.storage);
  }
  async fetch(req: Request): Promise<Response> {
    const kind = new URL(req.url).searchParams.get("kind");
    const r = await runRefContract(async () => {
      const prefix = `t${this.n++}_`;
      return kind === "kv"
        ? kvRefDb(await sqlKvStore(this.db, `${prefix}kv`))
        : sqlRefDb(this.db, prefix);
    });
    return Response.json(r);
  }
}

export default {
  async fetch(
    req: Request,
    env: {
      REFS: {
        idFromName(n: string): unknown;
        get(id: unknown): { fetch(r: Request): Promise<Response> };
      };
    },
  ) {
    return env.REFS.get(env.REFS.idFromName("x5")).fetch(req);
  },
};
