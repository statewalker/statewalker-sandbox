/** workerd: complete the fixture thin pack over SqliteFilesApi inside a Durable Object. */
import { newDoSqliteDb } from "@statewalker/db-sqlite-do";
import { SqliteFilesApi } from "@statewalker/webrun-files-sqlite";
import completed from "../fixtures/completed.idx";
import thin from "../fixtures/thin.pack";
import { fixtureBase } from "./fixture-base.js";
import { installPack } from "./index-pack.js";

export class PacksDo {
  private db: ReturnType<typeof newDoSqliteDb>;
  constructor(ctx: { storage: Parameters<typeof newDoSqliteDb>[0] }) {
    this.db = newDoSqliteDb(ctx.storage);
  }
  async fetch(): Promise<Response> {
    try {
      const fs = new SqliteFilesApi(this.db, { compression: null, tablePrefix: `t${Date.now()}_` });
      await fs.init();
      const r = await installPack(
        fs,
        "/objects/pack",
        (async function* () {
          for (let i = 0; i < thin.length; i += 4096) yield thin.subarray(i, i + 4096);
        })(),
        { externalBase: fixtureBase },
      );
      const same = r.idx.length === completed.length && r.idx.every((b, i) => b === completed[i]);
      return Response.json({ same, appended: r.stats.appended });
    } catch (e) {
      return Response.json({ error: String(e) });
    }
  }
}

export default {
  async fetch(
    req: Request,
    env: {
      PACKS: {
        idFromName(n: string): unknown;
        get(id: unknown): { fetch(r: Request): Promise<Response> };
      };
    },
  ) {
    return env.PACKS.get(env.PACKS.idFromName("x6b")).fetch(req);
  },
};
