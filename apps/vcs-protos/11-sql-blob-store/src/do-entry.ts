/** workerd: runs the X3b blob contract and X4's object contract over sqlBlobStore in a DO. */
import { newDoSqliteDb } from "@statewalker/db-sqlite-do";
import json from "../../09-git-objects/fixtures/corpus.json";
import { decodeCorpus } from "../../09-git-objects/src/corpus.js";
import { runObjectContract } from "../../09-git-objects/src/object-contract.js";
import { pattern, runBlobContract } from "./blob-contract.js";
import { sqlBlobStore } from "./sql-blob-store.js";

export class BlobsDo {
  private n = 0;
  private db: ReturnType<typeof newDoSqliteDb>;
  constructor(ctx: { storage: Parameters<typeof newDoSqliteDb>[0] }) {
    this.db = newDoSqliteDb(ctx.storage);
  }
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const make = (chunkSize?: number) =>
      sqlBlobStore(this.db, { prefix: `t${this.n++}_`, chunkSize });
    if (url.pathname === "/big") {
      try {
        const s = await make();
        const data = pattern(16 * 2 ** 20, 21);
        await s.putStaged(
          (async function* () {
            for (let i = 0; i < data.length; i += 65536) yield data.subarray(i, i + 65536);
          })(),
          () => "big",
        );
        let o = 0;
        let same = true;
        for await (const c of s.get("big")) {
          for (let i = 0; i < c.length && same; i++) same = c[i] === data[o + i];
          o += c.length;
        }
        return Response.json(
          same && o === data.length ? { ok: true } : { ok: false, error: `read ${o}` },
        );
      } catch (e) {
        return Response.json({ ok: false, error: String(e) });
      }
    }
    const kind = url.searchParams.get("kind");
    const r =
      kind === "object"
        ? await runObjectContract(() => make(), decodeCorpus(json))
        : await runBlobContract(() => make(4096), 4096);
    return Response.json(r);
  }
}

export default {
  async fetch(
    req: Request,
    env: {
      BLOBS: {
        idFromName(n: string): unknown;
        get(id: unknown): { fetch(r: Request): Promise<Response> };
      };
    },
  ) {
    return env.BLOBS.get(env.BLOBS.idFromName("x3b")).fetch(req);
  },
};
