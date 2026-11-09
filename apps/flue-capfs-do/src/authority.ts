// The authorization core, owned by the Workspace Durable Object. It holds the root key,
// the durable session state (mode, revocations) and a cache of verified tokens. Both
// transports go through it: an in-runtime FilteredFiles stub and a token-string call.

import { Biscuit, generateKeypair, type VerifiedBiscuit } from "@statewalker/webrun-biscuit";
import { asResource, fsError, join, normalise } from "./path.ts";
import { authorityBlock, isMode, MODES, OPS, type Op } from "./policy.ts";
import type { SqlFs } from "./sql-fs.ts";

interface SqlLike {
  exec(query: string, ...bindings: unknown[]): { toArray(): Record<string, unknown>[] };
}

const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export interface SessionInfo {
  session: string;
  user: string;
  mode: string;
  revokedAll: boolean;
  revokedIds: string[];
}

export class Authority {
  #sql: SqlLike;
  #secretKey: Uint8Array;
  readonly publicKey: Uint8Array;
  // Verified tokens, keyed by the token string (immutable); bounded.
  #verified = new Map<string, Promise<VerifiedBiscuit>>();
  stats = { authorizations: 0, verifications: 0 };

  constructor(sql: SqlLike) {
    this.#sql = sql;
    sql.exec("CREATE TABLE IF NOT EXISTS cap_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    sql.exec(`CREATE TABLE IF NOT EXISTS cap_sessions (
      session TEXT PRIMARY KEY, user TEXT NOT NULL, mode TEXT NOT NULL,
      revoked_all INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL)`);
    sql.exec(
      "CREATE TABLE IF NOT EXISTS cap_revoked (session TEXT NOT NULL, rid TEXT NOT NULL, PRIMARY KEY (session, rid))",
    );
    // The root key never leaves this cell.
    const rows = sql
      .exec("SELECT key, value FROM cap_meta WHERE key IN ('secret', 'public')")
      .toArray();
    const get = (k: string) => rows.find((r) => r.key === k)?.value as string | undefined;
    if (get("secret") && get("public")) {
      this.#secretKey = unb64(get("secret") as string);
      this.publicKey = unb64(get("public") as string);
    } else {
      const kp = generateKeypair();
      this.#secretKey = kp.secretKey;
      this.publicKey = kp.publicKey;
      sql.exec(
        "INSERT OR REPLACE INTO cap_meta (key, value) VALUES ('secret', ?), ('public', ?)",
        b64(kp.secretKey),
        b64(kp.publicKey),
      );
    }
  }

  // ---- sessions (issuer side) ----

  startSession(user: string, rights: string[], mode = "yolo"): { session: string; token: string } {
    if (!isMode(mode)) throw fsError("EINVAL", `unknown mode '${mode}'`);
    if (typeof user !== "string" || !user) throw fsError("EINVAL", "user is required");
    const clean = rights.map((r) => normalise(r));
    const session = crypto.randomUUID();
    this.#sql.exec(
      "INSERT INTO cap_sessions (session, user, mode, created) VALUES (?, ?, ?, ?)",
      session,
      user,
      mode,
      Date.now(),
    );
    const token = Biscuit.build(
      this.#secretKey,
      authorityBlock({ user, session, rights: clean }),
    ).toBase64();
    return { session, token };
  }

  setMode(session: string, mode: string): SessionInfo {
    if (!isMode(mode)) throw fsError("EINVAL", `unknown mode '${mode}'`);
    this.#sessionRow(session);
    this.#sql.exec("UPDATE cap_sessions SET mode = ? WHERE session = ?", mode, session);
    return this.sessionInfo(session);
  }

  /** Without `rid`, cuts the whole session; with it, cuts one capability and all its descendants. */
  revoke(session: string, rid?: string): SessionInfo {
    this.#sessionRow(session);
    if (rid)
      this.#sql.exec(
        "INSERT OR IGNORE INTO cap_revoked (session, rid) VALUES (?, ?)",
        session,
        rid,
      );
    else this.#sql.exec("UPDATE cap_sessions SET revoked_all = 1 WHERE session = ?", session);
    return this.sessionInfo(session);
  }

  sessionInfo(session: string): SessionInfo {
    const row = this.#sessionRow(session);
    const revokedIds = this.#sql
      .exec("SELECT rid FROM cap_revoked WHERE session = ?", session)
      .toArray()
      .map((r) => String(r.rid));
    return {
      session,
      user: String(row.user),
      mode: String(row.mode),
      revokedAll: !!row.revoked_all,
      revokedIds,
    };
  }

  #sessionRow(session: string) {
    const row = this.#sql
      .exec("SELECT user, mode, revoked_all FROM cap_sessions WHERE session = ?", session)
      .toArray()[0];
    if (!row) throw fsError("EACCES", `unknown session '${session}'`);
    return row;
  }

  // ---- verification (owner side) ----

  verify(token: string): Promise<VerifiedBiscuit> {
    let v = this.#verified.get(token);
    if (!v) {
      this.stats.verifications++;
      v = Promise.resolve()
        .then(() => Biscuit.fromBase64(token).verifyAsync(this.publicKey))
        .catch(() => {
          throw fsError("EACCES", "invalid token");
        });
      this.#verified.set(token, v);
      if (this.#verified.size > 1000)
        this.#verified.delete(this.#verified.keys().next().value as string);
    }
    return v;
  }

  /** The session a token was minted for, read from its authority block only. */
  #sids = new Map<string, string>();
  async sessionOf(token: string): Promise<string> {
    const cached = this.#sids.get(token);
    if (cached) return cached;
    const v = await this.verify(token);
    const facts = v.evaluate("allow if true;").query("s($x) <- session($x)");
    const sid = facts[0]?.terms[0];
    if (!sid || (sid as { t: string }).t !== "str") throw fsError("EACCES", "token has no session");
    const value = String((sid as { v: unknown }).v);
    this.#sids.set(token, value);
    if (this.#sids.size > 1000) this.#sids.delete(this.#sids.keys().next().value as string);
    return value;
  }

  async revocationIds(token: string): Promise<string[]> {
    return (await this.verify(token)).revocationIds;
  }

  /** Datalog decision for one (op, path). Session state is read fresh: mode and revocation apply on the next call. */
  async check(token: string, op: Op, path: string): Promise<boolean> {
    this.stats.authorizations++;
    const v = await this.verify(token);
    const sid = await this.sessionOf(token);
    const row = this.#sql
      .exec("SELECT mode, revoked_all FROM cap_sessions WHERE session = ?", sid)
      .toArray()[0];
    if (!row) throw fsError("EACCES", "unknown session");
    if (row.revoked_all) throw fsError("EACCES", "session revoked");
    const ids = v.revocationIds;
    if (ids.length > 0) {
      const marks = ids.map(() => "?").join(",");
      const hit = this.#sql
        .exec(
          `SELECT 1 FROM cap_revoked WHERE session = ? AND rid IN (${marks}) LIMIT 1`,
          sid,
          ...ids,
        )
        .toArray();
      if (hit.length > 0) throw fsError("EACCES", "capability revoked");
    }
    const policy = MODES[String(row.mode)];
    if (!policy) throw fsError("EACCES", `unknown mode '${String(row.mode)}'`);
    const r = v.authorize(
      `operation({op});\nresource({path});\ncheck if session({sid});\n${policy}`,
      {
        params: { op, path: asResource(path), sid },
      },
    );
    return r.kind === "ok";
  }
}

export type FsRequest =
  | { op: "call"; method: string; path: string; args?: unknown[] }
  | { op: "readdir"; path: string }
  | { op: "move"; kind: "cp" | "mv"; path: string; dst: string; opts?: unknown };

/**
 * The guarded file API for one token. Every operation is authorized here, in the owner
 * cell, then forwarded to the store; only plain data is returned.
 */
export class FsGate {
  #store: SqlFs;
  #auth: Authority;
  #token: string;
  constructor(store: SqlFs, auth: Authority, token: string) {
    this.#store = store;
    this.#auth = auth;
    this.#token = token;
  }

  async #authorize(op: Op, raw: unknown): Promise<string> {
    const path = normalise(raw);
    if (!(await this.#auth.check(this.#token, op, path)))
      throw fsError("EACCES", `permission denied, ${op} '${path}'`);
    return path;
  }

  async call(method: string, p: string, ...args: unknown[]): Promise<unknown> {
    const op = OPS[method];
    if (!op) throw fsError("ENOSYS", `method not available '${method}'`);
    if (method === "readdir") return this.readdir(p);
    const path = await this.#authorize(op, p);
    // biome-ignore lint/suspicious/noExplicitAny: dispatch over the store's method table
    const fn = (this.#store as any)[method] as (...a: unknown[]) => Promise<unknown>;
    return fn.call(this.#store, path, ...args);
  }

  /** readdir on an ancestor of a right only shows the children the token may reach. */
  async readdir(p: string): Promise<string[]> {
    const path = await this.#authorize("list", p);
    const names = await this.#store.readdir(path);
    const out: string[] = [];
    for (const name of names)
      if (await this.#auth.check(this.#token, "list", join(path, name))) out.push(name);
    return out;
  }

  async move(kind: "cp" | "mv", src: string, dst: string, opts?: unknown): Promise<void> {
    if (kind !== "cp" && kind !== "mv") throw fsError("ENOSYS", `move kind '${String(kind)}'`);
    const s = await this.#authorize("read", src);
    if (kind === "mv") await this.#authorize("write", src);
    const d = await this.#authorize("write", dst);
    if (kind === "cp") return this.#store.cp(s, d, opts as { recursive?: boolean });
    return this.#store.mv(s, d);
  }

  dispatch(req: FsRequest): Promise<unknown> {
    switch (req?.op) {
      case "call":
        return this.call(req.method, req.path, ...(req.args ?? []));
      case "readdir":
        return this.readdir(req.path);
      case "move":
        return this.move(req.kind, req.path, req.dst, req.opts);
      default:
        return Promise.reject(
          fsError("ENOSYS", `unknown request '${String((req as { op?: string })?.op)}'`),
        );
    }
  }
}
