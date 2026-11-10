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

/** The Db failing at its statement `k` (inside transactions too): a step dying mid-batch. */
function dying<T extends object>(db: T, k: number): T {
  let n = 0;
  type Q = {
    query(sql: string, p?: unknown[]): Promise<unknown>;
    exec(sql: string): Promise<unknown>;
  };
  const wrap = (inner: Q): Q => ({
    query: (sql, p) => {
      if (++n === k) return Promise.reject(new Error(`db died at statement ${k}`));
      return inner.query(sql, p);
    },
    exec: (sql) => {
      if (++n === k) return Promise.reject(new Error(`db died at statement ${k}`));
      return inner.exec(sql);
    },
  });
  const outer = Object.assign(Object.create(db), wrap(db as unknown as Q)) as Record<
    symbol,
    unknown
  >;
  for (const sym of Object.getOwnPropertySymbols(db)) {
    const hook = (db as unknown as Record<symbol, (cb: (tx: Q) => Promise<unknown>) => unknown>)[
      sym
    ];
    if (typeof hook === "function")
      outer[sym] = (cb: (tx: Q) => Promise<unknown>) => hook((tx) => cb(wrap(tx)));
  }
  return outer as unknown as T;
}

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
      // a small chunk size: many objects take X3b's staged (chunked) path
      const chunkSize = 4096;
      if (url.pathname === "/step") {
        const units = Number(url.searchParams.get("units") ?? "40");
        const fail = Number(url.searchParams.get("fail") ?? "0");
        const db = fail ? dying(this.db, fail) : this.db;
        const r = await explodeStep(db, reader, { units, batch: 16, chunkSize });
        return Response.json(r);
      }
      const objects = await explodedObjects(this.db, { chunkSize });
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
