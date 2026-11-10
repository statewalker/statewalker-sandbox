/**
 * workerd: install X6a's fixture pack (X6b1) into SqliteFilesApi, then explode it into X3b's
 * tables in steps; the test restarts the runtime between requests (persistent storage).
 */
import { newDoSqliteDb } from "@statewalker/db-sqlite-do";
import { SqliteFilesApi } from "@statewalker/webrun-files-sqlite";
import pack from "../../12-index-pack/fixtures/sample.pack";
import { openPack } from "../../13-pack-reader/src/pack-reader.js";
import { installPack } from "../../14-thin-packs/src/index-pack.js";
import { explodedObjects, explodeStep } from "./explode.js";

export class ObjectsDo {
  private db: ReturnType<typeof newDoSqliteDb>;
  constructor(ctx: { storage: Parameters<typeof newDoSqliteDb>[0] }) {
    this.db = newDoSqliteDb(ctx.storage);
  }
  async fetch(req: Request): Promise<Response> {
    try {
      const fs = new SqliteFilesApi(this.db, { compression: null, tablePrefix: "x6b3_" });
      await fs.init();
      const url = new URL(req.url);
      if (url.pathname === "/install") {
        await installPack(
          fs,
          "/objects/pack",
          (async function* () {
            for (let i = 0; i < pack.length; i += 4096) yield pack.subarray(i, i + 4096);
          })(),
        );
        return Response.json({ ok: true });
      }
      let name = "";
      for await (const e of fs.list("/objects/pack"))
        if (e.name.endsWith(".pack")) name = e.name.slice(0, -5);
      const reader = await openPack(fs, `/objects/pack/${name}.pack`, `/objects/pack/${name}.idx`);
      if (url.pathname === "/step") {
        const units = Number(url.searchParams.get("units"));
        const r = await explodeStep(this.db, reader, { units, batch: 16 });
        return Response.json(r);
      }
      const objects = await explodedObjects(this.db);
      let verified = 0;
      for (const id of reader.ids()) {
        const o = await objects.get(id, { verify: true });
        if (!o) continue;
        for await (const _ of o.content);
        verified++;
      }
      return Response.json({ verified, total: reader.count });
    } catch (e) {
      return Response.json({ error: String(e) });
    }
  }
}

export default {
  async fetch(
    req: Request,
    env: {
      OBJS: {
        idFromName(n: string): unknown;
        get(id: unknown): { fetch(r: Request): Promise<Response> };
      };
    },
  ) {
    return env.OBJS.get(env.OBJS.idFromName("x6b3")).fetch(req);
  },
};
