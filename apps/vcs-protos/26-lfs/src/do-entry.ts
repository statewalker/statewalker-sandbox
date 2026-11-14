/** workerd: the LFS store over the SQL repository's files and the server, in a Durable Object. */
import { newDoSqliteDb } from "@statewalker/db-sqlite-do";
import { sqlRepository } from "../../17-repository/src/repository.js";
import { lfsHandler } from "./server.js";
import { repoLfsStore } from "./store.js";

const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

export class LfsDo {
  private db: ReturnType<typeof newDoSqliteDb>;
  constructor(ctx: { storage: Parameters<typeof newDoSqliteDb>[0] }) {
    this.db = newDoSqliteDb(ctx.storage);
  }
  async fetch(_req: Request): Promise<Response> {
    try {
      const repo = await sqlRepository(this.db);
      const handler = lfsHandler(repoLfsStore(repo));
      const content = new Uint8Array(300_000).map((_, i) => (i * 31) % 251);
      const oid = hex(new Uint8Array(await crypto.subtle.digest("SHA-256", content)));
      const base = "http://do/repo.git/info/lfs";
      const json = {
        "content-type": "application/vnd.git-lfs+json",
        accept: "application/vnd.git-lfs+json",
      };
      const batch = (await (
        await handler(
          new Request(`${base}/objects/batch`, {
            method: "POST",
            headers: json,
            body: JSON.stringify({ operation: "upload", objects: [{ oid, size: content.length }] }),
          }),
        )
      ).json()) as {
        objects: { actions?: { upload?: { href: string; header?: Record<string, string> } } }[];
      };
      const up = batch.objects[0]?.actions?.upload;
      if (!up) throw new Error("no upload action");
      const put = await handler(
        new Request(up.href, { method: "PUT", headers: up.header, body: content }),
      );
      const ranged = await handler(
        new Request(`${base}/objects/${oid}`, { headers: { range: "bytes=100000-" } }),
      );
      const tail = new Uint8Array(await ranged.arrayBuffer());
      return Response.json({
        put: put.status,
        ranged: ranged.status,
        tailOk: tail.length === 200_000 && tail.every((b, i) => b === content[100_000 + i]),
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
    return env.REPO.get(env.REPO.idFromName("x10a")).fetch(req);
  },
};
