/** workerd: index the fixture pack over SqliteFilesApi inside a Durable Object. */
import { newDoSqliteDb } from "@statewalker/db-sqlite-do";
import { SqliteFilesApi } from "@statewalker/webrun-files-sqlite";
import idx from "../fixtures/sample.idx";
import pack from "../fixtures/sample.pack";
import { installPack } from "./index-pack.js";

export class PacksDo {
  private db: ReturnType<typeof newDoSqliteDb>;
  constructor(ctx: { storage: Parameters<typeof newDoSqliteDb>[0] }) {
    this.db = newDoSqliteDb(ctx.storage);
  }
  async fetch(): Promise<Response> {
    try {
      const fs = new SqliteFilesApi(this.db, { compression: null, tablePrefix: `p${Date.now()}_` });
      await fs.init();
      const r = await installPack(
        fs,
        "/objects/pack",
        (async function* () {
          for (let i = 0; i < pack.length; i += 4096) yield pack.subarray(i, i + 4096);
        })(),
      );
      const same = r.idx.length === idx.length && r.idx.every((b, i) => b === idx[i]);
      return Response.json({ same, entries: r.entries.length });
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
    return env.PACKS.get(env.PACKS.idFromName("x6")).fetch(req);
  },
};
