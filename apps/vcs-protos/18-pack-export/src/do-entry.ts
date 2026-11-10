/** workerd: receive X6a's fixture pack into the SQL backend, then export its history (X6c). */
import { newDoSqliteDb } from "@statewalker/db-sqlite-do";
import pack from "../../12-index-pack/fixtures/sample.pack";
import { log } from "../../17-repository/src/commands.js";
import { sqlRepository } from "../../17-repository/src/sql-repository.js";
import { exportPack } from "./export.js";

export class ExportDo {
  private db: ReturnType<typeof newDoSqliteDb>;
  constructor(ctx: { storage: Parameters<typeof newDoSqliteDb>[0] }) {
    this.db = newDoSqliteDb(ctx.storage);
  }
  async fetch(): Promise<Response> {
    try {
      const repo = await sqlRepository(this.db);
      await repo.objects.installPack(
        (async function* () {
          for (let i = 0; i < pack.length; i += 4096) yield pack.subarray(i, i + 4096);
        })(),
      );
      // the fixture's head: the commit no other commit names
      const commits: string[] = [];
      for await (const id of repo.objects.list()) {
        const o = await repo.objects.get(id);
        if (o?.type === "commit") commits.push(id);
        await o?.content[Symbol.asyncIterator]().return?.();
      }
      const named = new Set<string>();
      for (const c of commits) for (const p of (await log(repo, c, 2)).slice(1)) named.add(p);
      const head = commits.find((c) => !named.has(c)) as string;
      const parts: Uint8Array[] = [];
      for await (const c of exportPack(repo, [head], [])) parts.push(c);
      const body = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
      let o = 0;
      for (const p of parts) {
        body.set(p, o);
        o += p.length;
      }
      return new Response(body, { headers: { "x-head": head } });
    } catch (e) {
      return new Response("", { headers: { "x-error": String(e) } });
    }
  }
}

export default {
  async fetch(
    req: Request,
    env: {
      REPO: {
        idFromName(n: string): unknown;
        get(id: unknown): { fetch(r: Request): Promise<Response> };
      };
    },
  ) {
    return env.REPO.get(env.REPO.idFromName("x6c")).fetch(req);
  },
};
