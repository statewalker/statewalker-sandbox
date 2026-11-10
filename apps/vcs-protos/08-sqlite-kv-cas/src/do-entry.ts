/**
 * workerd: a SQLite-backed Durable Object exposing the KvStore over HTTP for the tests.
 * POST /contract runs the R1 contract inside the DO; POST /cas {key, expected, next} (base64) runs
 * one cas; GET /get?key=… reads; POST /put-size?bytes=N stores and reads back an N-byte value.
 */
import { newDoSqliteDb } from "@statewalker/db-sqlite-do";
import type { KvStore } from "@statewalker/webrun-storage";
import { runKvContract } from "./kv-contract.js";
import { sqlKvStore } from "./sql-kv-store.js";

const b64 = (b: Uint8Array | undefined) =>
  b === undefined ? null : btoa(String.fromCharCode(...b));
const unb64 = (s: string | null) =>
  s === null ? undefined : Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export class KvDo {
  private store: Promise<KvStore>;
  constructor(ctx: { storage: Parameters<typeof newDoSqliteDb>[0] }) {
    this.store = sqlKvStore(newDoSqliteDb(ctx.storage));
  }
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const kv = await this.store;
    if (url.pathname === "/contract")
      return Response.json(await runKvContract(() => Promise.resolve(kv)));
    if (url.pathname === "/cas") {
      const { key, expected, next } = (await req.json()) as {
        key: string;
        expected: string | null;
        next: string | null;
      };
      return Response.json({ ok: await kv.cas(key, unb64(expected), unb64(next)) });
    }
    if (url.pathname === "/get")
      return Response.json({ value: b64(await kv.get(url.searchParams.get("key") ?? "")) });
    if (url.pathname === "/put-size") {
      const n = Number(url.searchParams.get("bytes"));
      const value = new Uint8Array(n).map((_, i) => i & 0xff);
      try {
        await kv.put(`size-${n}`, value);
        const back = await kv.get(`size-${n}`);
        return Response.json({ ok: back?.length === n && back.every((v, i) => v === (i & 0xff)) });
      } catch (e) {
        return Response.json({ ok: false, error: String(e) });
      }
    }
    return new Response("not found", { status: 404 });
  }
}

export default {
  async fetch(
    req: Request,
    env: {
      KV: {
        idFromName(n: string): unknown;
        get(id: unknown): { fetch(r: Request): Promise<Response> };
      };
    },
  ) {
    const url = new URL(req.url);
    const ns = url.searchParams.get("ns") ?? "default";
    return env.KV.get(env.KV.idFromName(ns)).fetch(req);
  },
};
