/**
 * workerd: index X6a's fixture pack as a resumable job over SqliteFilesApi inside a Durable
 * Object. The test disposes and restarts the runtime between steps (persistent storage), so every
 * step runs in a fresh isolate from what the previous one committed.
 */
import { newDoSqliteDb } from "@statewalker/db-sqlite-do";
import { SqliteFilesApi } from "@statewalker/webrun-files-sqlite";
import idx from "../../12-index-pack/fixtures/sample.idx";
import pack from "../../12-index-pack/fixtures/sample.pack";
import { startIndexJob, stepIndexJob } from "./index-job.js";

export class PacksDo {
  private db: ReturnType<typeof newDoSqliteDb>;
  constructor(ctx: { storage: Parameters<typeof newDoSqliteDb>[0] }) {
    this.db = newDoSqliteDb(ctx.storage);
  }
  async fetch(req: Request): Promise<Response> {
    try {
      // a fixed prefix: the same tables across restarts
      const fs = new SqliteFilesApi(this.db, { compression: null, tablePrefix: "x6b2_" });
      await fs.init();
      const url = new URL(req.url);
      if (url.pathname === "/start") {
        const id = await startIndexJob(
          fs,
          "/objects/pack",
          (async function* () {
            for (let i = 0; i < pack.length; i += 4096) yield pack.subarray(i, i + 4096);
          })(),
        );
        return Response.json({ id });
      }
      const id = url.searchParams.get("id") as string;
      const units = Number(url.searchParams.get("units"));
      const r = await stepIndexJob(fs, "/objects/pack", id, { units });
      if (!r.done) return Response.json({ done: false, phase: r.phase, units: r.units });
      const same = r.result.idx.length === idx.length && r.result.idx.every((b, i) => b === idx[i]);
      const names: string[] = [];
      for await (const e of fs.list("/objects/pack")) names.push(e.name);
      return Response.json({ done: true, same, names, packId: r.result.packId });
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
    return env.PACKS.get(env.PACKS.idFromName("x6b2")).fetch(req);
  },
};
