/** workerd: read every object of X6a's fixture pack, with verify, over SqliteFilesApi in a DO. */
import { newDoSqliteDb } from "@statewalker/db-sqlite-do";
import { SqliteFilesApi } from "@statewalker/webrun-files-sqlite";
import idx from "../../12-index-pack/fixtures/sample.idx";
import pack from "../../12-index-pack/fixtures/sample.pack";
import { openPack } from "./pack-reader.js";

export class ReadDo {
  private db: ReturnType<typeof newDoSqliteDb>;
  constructor(ctx: { storage: Parameters<typeof newDoSqliteDb>[0] }) {
    this.db = newDoSqliteDb(ctx.storage);
  }
  async fetch(): Promise<Response> {
    try {
      const fs = new SqliteFilesApi(this.db, { compression: null, tablePrefix: `r${Date.now()}_` });
      await fs.init();
      await fs.write("/p.pack", [pack]);
      await fs.write("/p.idx", [idx]);
      const reader = await openPack(fs, "/p.pack", "/p.idx");
      let verified = 0;
      for (const oid of reader.ids()) {
        const o = await reader.get(oid, { verify: true });
        for await (const _ of o?.content ?? []);
        verified++;
      }
      return Response.json({ verified, count: reader.count });
    } catch (e) {
      return Response.json({ error: String(e) });
    }
  }
}

export default {
  async fetch(
    req: Request,
    env: {
      READ: {
        idFromName(n: string): unknown;
        get(id: unknown): { fetch(r: Request): Promise<Response> };
      };
    },
  ) {
    return env.READ.get(env.READ.idFromName("x6r")).fetch(req);
  },
};
