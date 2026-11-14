/**
 * workerd: a SQLite-backed Durable Object that runs the X4 contract over SqliteFilesApi on
 * ctx.storage.sql (through statewalker-db's newDoSqliteDb). Each contract case gets fresh tables.
 */
import { newDoSqliteDb } from "@statewalker/db-sqlite-do";
import { SqliteFilesApi } from "@statewalker/webrun-files-sqlite";
import json from "../fixtures/corpus.json";
import { decodeCorpus } from "./corpus.js";
import { runObjectContract } from "./object-contract.js";
import { filesStagingStore } from "./staging.js";

export class ObjectsDo {
  private tables = 0; // fresh table prefix per contract case, also across requests
  constructor(private ctx: { storage: Parameters<typeof newDoSqliteDb>[0] }) {}
  async fetch(req: Request): Promise<Response> {
    if (new URL(req.url).pathname !== "/contract")
      return new Response("not found", { status: 404 });
    const db = newDoSqliteDb(this.ctx.storage);
    const r = await runObjectContract(async () => {
      const fs = new SqliteFilesApi(db, { tablePrefix: `t${this.tables++}_`, compression: null });
      await fs.init();
      return filesStagingStore(fs, "/objects");
    }, decodeCorpus(json));
    return Response.json(r);
  }
}

export default {
  async fetch(
    req: Request,
    env: {
      OBJECTS: {
        idFromName(n: string): unknown;
        get(id: unknown): { fetch(r: Request): Promise<Response> };
      };
    },
  ) {
    return env.OBJECTS.get(env.OBJECTS.idFromName("x4")).fetch(req);
  },
};
