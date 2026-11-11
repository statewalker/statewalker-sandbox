/** workerd: the façade over the SQL repository in a Durable Object — init, commits, log, gc. */
import { newDoSqliteDb } from "@statewalker/db-sqlite-do";
import { openRepository } from "./vcs.js";

export class FacadeDo {
  private db: ReturnType<typeof newDoSqliteDb>;
  constructor(ctx: { storage: Parameters<typeof newDoSqliteDb>[0] }) {
    this.db = newDoSqliteDb(ctx.storage);
  }
  async fetch(_req: Request): Promise<Response> {
    try {
      const enc = new TextEncoder();
      const v = await openRepository(
        { db: this.db },
        { init: true, identity: { name: "Durable", email: "do@example.com" } },
      );
      for (let i = 0; i < 3; i++)
        await v.commit({ files: { "n.txt": enc.encode(`version ${i}\n`) }, message: `c${i}\n` });
      await v.gc({ graceMs: 0 });
      return Response.json({
        log: await v.log("HEAD"),
        gc: "done",
        head: await v.repo.refs.read("HEAD"),
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
    return env.REPO.get(env.REPO.idFromName("x16b")).fetch(req);
  },
};
