/** workerd: the SQL repository in a Durable Object — the command sequence, then X6a's fixture pack. */
import { newDoSqliteDb } from "@statewalker/db-sqlite-do";
import pack from "../../12-index-pack/fixtures/sample.pack";
import { log, receivePack } from "./commands.js";
import { demoCommits } from "./demo.js";
import { sqlRepository } from "./repository.js";

export class RepoDo {
  private db: ReturnType<typeof newDoSqliteDb>;
  constructor(ctx: { storage: Parameters<typeof newDoSqliteDb>[0] }) {
    this.db = newDoSqliteDb(ctx.storage);
  }
  async fetch(req: Request): Promise<Response> {
    try {
      const repo = await sqlRepository(this.db);
      await demoCommits(repo);
      await receivePack(
        repo,
        (async function* () {
          for (let i = 0; i < pack.length; i += 4096) yield pack.subarray(i, i + 4096);
        })(),
      );
      const head = new URL(req.url).searchParams.get("head") as string;
      await repo.refs.batch([{ name: "refs/heads/fixture", old: null, new: head }]);
      return Response.json({
        log: await log(repo, "refs/heads/main"),
        fixtureLog: await log(repo, "refs/heads/fixture"),
      });
    } catch (e) {
      return Response.json({ error: String(e) });
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
    return env.REPO.get(env.REPO.idFromName("x16")).fetch(req);
  },
};
