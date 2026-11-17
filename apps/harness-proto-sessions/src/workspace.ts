// PROTOTYPE (statewalker/statewalker-root#89). The Workspace cell: the store, the role source
// (each project's `.system/access` file), user sessions, agent sessions, approvals, and the gate
// every file call of every agent goes through.
//
//   access token (issuer key: user, workspace, expiry) → opens or resumes the user's ONE user
//     session in this workspace; the user session holds the mode.
//   agent capability (this workspace's root key: agent_session(id)) → one agent session; its
//     sub-agents get their own, linked by `parent`.
//
// Checked at each action, never fixed at start: the role (read live from the access file), the
// mode (the user session's, plus every ancestor agent's own stricter mode), and whether the
// agent session, any ancestor, or the user session was revoked.

import { DurableObject } from "cloudflare:workers";
import {
  Biscuit,
  fromBase64,
  generateKeypair,
  toBase64,
  type VerifiedBiscuit,
} from "@statewalker/webrun-biscuit";
import { fsError, normalise } from "../../flue-capfs-do/src/path.ts";
import { SqlFs } from "../../flue-capfs-do/src/sql-fs.ts";
import type { Issuer } from "./issuer.ts";
import { ACTIONS, AGENTS, type Decision, MODES, ROLE_TOOLS, strictest } from "./model.ts";

export interface Env {
  ISSUER: DurableObjectNamespace<Issuer>;
}

const q = (s: string) => JSON.stringify(s);
type Row = Record<string, string | number | null>;

const SYSTEM = ".system";
const POLICY = `
allow if operation("read"), resource("/");
allow if operation("read"), role($r), {"reader", "editor", "owner"}.contains($r), resource($p), root($x), $p.starts_with($x);
allow if operation("write"), role($r), {"editor", "owner"}.contains($r), resource($p), root($x), $p.starts_with($x);
`;

const encode = (args: unknown[]) =>
  JSON.stringify(args.map((a) => (a instanceof Uint8Array ? { $b64: toBase64(a) } : a)));
const decode = (text: string) =>
  (JSON.parse(text) as unknown[]).map((a) =>
    a && typeof a === "object" && "$b64" in (a as object)
      ? fromBase64((a as { $b64: string }).$b64)
      : a,
  );

export class Workspace extends DurableObject<Env> {
  #sql: SqlStorage;
  #store: SqlFs;
  #root: { secret: Uint8Array; public: Uint8Array };
  #issuerKey?: Promise<Uint8Array>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#sql = ctx.storage.sql;
    this.#store = new SqlFs(ctx.storage.sql);
    this.#sql.exec(`
      CREATE TABLE IF NOT EXISTS ws_meta (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE IF NOT EXISTS user_sessions (id TEXT PRIMARY KEY, user TEXT, mode TEXT, state TEXT, created INTEGER);
      CREATE TABLE IF NOT EXISTS agent_sessions (id TEXT PRIMARY KEY, user_session TEXT, parent TEXT, project TEXT,
        agent TEXT, tools TEXT, mode TEXT, state TEXT, created INTEGER);
      CREATE TABLE IF NOT EXISTS approvals (id TEXT PRIMARY KEY, agent_session TEXT, user_session TEXT, method TEXT,
        path TEXT, args TEXT, state TEXT, reason TEXT, created INTEGER);`);
    const get = (k: string) =>
      this.#sql.exec("SELECT value FROM ws_meta WHERE key = ?", k).toArray()[0]?.value as
        | string
        | undefined;
    if (get("secret"))
      this.#root = {
        secret: fromBase64(get("secret") as string),
        public: fromBase64(get("public") as string),
      };
    else {
      const kp = generateKeypair();
      this.#root = { secret: kp.secretKey, public: kp.publicKey };
      this.#sql.exec(
        "INSERT INTO ws_meta VALUES ('secret', ?), ('public', ?)",
        toBase64(kp.secretKey),
        toBase64(kp.publicKey),
      );
    }
  }

  #one(query: string, ...args: unknown[]): Row | undefined {
    return this.#sql.exec(query, ...args).toArray()[0] as Row | undefined;
  }

  // ---- access tokens and the user session ----------------------------------------------------

  async #user(accessToken: string, workspace: string): Promise<string> {
    this.#issuerKey ??= this.env.ISSUER.get(this.env.ISSUER.idFromName("issuer"))
      .publicKey()
      .then((k) => fromBase64(k as string));
    let v: VerifiedBiscuit;
    try {
      v = await Biscuit.fromBase64(accessToken).verifyAsync(await this.#issuerKey);
    } catch {
      throw fsError("EACCES", "invalid access token");
    }
    // The signature proves the issuer wrote these facts; expiry and workspace are checked here.
    const facts = v
      .evaluate("allow if true;")
      .query("x($u, $e, $w) <- user($u), expires($e), workspace($w)");
    const [u, e, w] = (facts[0]?.terms ?? []).map((t) => (t as { v: unknown }).v);
    if (w !== workspace) throw fsError("EACCES", "the access token is for another workspace");
    if (Number(e) <= Date.now()) throw fsError("EACCES", "access token expired");
    return String(u);
  }

  /** Opens the user's user session here, or resumes the active one (one per user and workspace). */
  async openUserSession(accessToken: string, workspace: string) {
    const user = await this.#user(accessToken, workspace);
    let row = this.#one("SELECT * FROM user_sessions WHERE user = ? AND state = 'active'", user);
    if (!row) {
      const id = `us-${crypto.randomUUID()}`;
      this.#sql.exec(
        "INSERT INTO user_sessions VALUES (?, ?, 'default', 'active', ?)",
        id,
        user,
        Date.now(),
      );
      row = this.#one("SELECT * FROM user_sessions WHERE id = ?", id);
    }
    return row as Row;
  }

  async me(accessToken: string, workspace: string) {
    const us = await this.openUserSession(accessToken, workspace);
    return {
      id: us.id,
      user: us.user,
      mode: us.mode,
      sessions: this.#sql
        .exec(
          "SELECT id, parent, project, agent, tools, mode, state FROM agent_sessions WHERE user_session = ?",
          us.id,
        )
        .toArray(),
      approvals: this.#sql
        .exec(
          "SELECT id, agent_session, method, path, state FROM approvals WHERE user_session = ? AND state = 'pending'",
          us.id,
        )
        .toArray(),
    };
  }

  /** Only the user switches modes, and only on the user session. */
  async setMode(accessToken: string, workspace: string, mode: string) {
    if (!MODES[mode]) throw fsError("EINVAL", `unknown mode '${mode}'`);
    const us = await this.openUserSession(accessToken, workspace);
    this.#sql.exec("UPDATE user_sessions SET mode = ? WHERE id = ?", mode, us.id);
    return this.me(accessToken, workspace);
  }

  async revokeUserSession(accessToken: string, workspace: string) {
    const us = await this.openUserSession(accessToken, workspace);
    this.#sql.exec("UPDATE user_sessions SET state = 'revoked' WHERE id = ?", us.id);
    this.#sql.exec(
      "UPDATE agent_sessions SET state = 'stopped' WHERE user_session = ? AND state = 'active'",
      us.id,
    );
    return { revoked: us.id };
  }

  // ---- agent sessions ------------------------------------------------------------------------

  async #role(project: string, user: string): Promise<string | undefined> {
    const file = `/${project}/${SYSTEM}/access`;
    if (!(await this.#store.exists(file))) return undefined;
    return (JSON.parse(await this.#store.readFile(file)) as Record<string, string>)[user];
  }

  /**
   * Starts an agent session in a project where the user is a member. Its tools are what the
   * agent requests, cut to what the role allows (or, for a sub-agent, to its parent's tools).
   */
  async startAgentSession(
    accessToken: string,
    workspace: string,
    req: { project: string; agent: string; parent?: string },
  ) {
    const us = await this.openUserSession(accessToken, workspace);
    const def = AGENTS[req.agent];
    if (!def) throw fsError("EINVAL", `unknown agent '${req.agent}'`);
    let ceiling: string[];
    if (req.parent) {
      const parent = this.#one(
        "SELECT * FROM agent_sessions WHERE id = ? AND user_session = ?",
        req.parent,
        us.id,
      );
      if (!parent) throw fsError("ENOENT", "no such parent session");
      if (parent.state !== "active") throw fsError("EACCES", `parent session is ${parent.state}`);
      if (parent.project !== req.project)
        throw fsError("EINVAL", "a sub-agent stays in its parent's project");
      ceiling = JSON.parse(String(parent.tools));
    } else {
      const role = await this.#role(req.project, String(us.user));
      if (!role) throw fsError("EACCES", `${us.user} is not a member of ${req.project}`);
      ceiling = ROLE_TOOLS[role] ?? [];
    }
    const tools = def.tools.filter((t) => ceiling.includes(t));
    const dropped = def.tools.filter((t) => !ceiling.includes(t));
    const id = `as-${crypto.randomUUID()}`;
    this.#sql.exec(
      "INSERT INTO agent_sessions VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?)",
      id,
      us.id,
      req.parent ?? null,
      req.project,
      req.agent,
      JSON.stringify(tools),
      def.mode ?? null,
      Date.now(),
    );
    const capability = Biscuit.build(this.#root.secret, `agent_session(${q(id)});`).toBase64();
    return {
      id,
      project: req.project,
      agent: req.agent,
      parent: req.parent ?? null,
      tools,
      dropped,
      mode: def.mode ?? null,
      capability,
    };
  }

  /** Revoking a session stops it and every session started from it; siblings keep running. */
  async archive(accessToken: string, workspace: string, id: string) {
    const us = await this.openUserSession(accessToken, workspace);
    const stop = (sid: string): string[] => {
      this.#sql.exec(
        "UPDATE agent_sessions SET state = 'revoked' WHERE id = ? AND user_session = ? AND state = 'active'",
        sid,
        us.id,
      );
      const kids = this.#sql.exec("SELECT id FROM agent_sessions WHERE parent = ?", sid).toArray();
      return [sid, ...kids.flatMap((k) => stop(String(k.id)))];
    };
    return { revoked: stop(id) };
  }

  /** The agent session a request may act on: the caller's own. */
  async ownSession(accessToken: string, workspace: string, id: string) {
    const us = await this.openUserSession(accessToken, workspace);
    const row = this.#one(
      "SELECT * FROM agent_sessions WHERE id = ? AND user_session = ?",
      id,
      us.id,
    );
    if (!row) throw fsError("ENOENT", "no such agent session");
    return row;
  }

  // ---- the gate ----------------------------------------------------------------------------------

  async #agentOf(capability: string): Promise<string> {
    let v: VerifiedBiscuit;
    try {
      v = await Biscuit.fromBase64(capability).verifyAsync(this.#root.public);
    } catch {
      throw fsError("EACCES", "invalid capability");
    }
    const f = v.evaluate("allow if true;").query("x($s) <- agent_session($s)");
    return String((f[0]?.terms[0] as { v: unknown })?.v);
  }

  /** Every check of one action. `approved` skips "ask" (the user already answered), nothing else. */
  async #decide(agentId: string, action: "read" | "write", path: string, approved: boolean) {
    const a = this.#one("SELECT * FROM agent_sessions WHERE id = ?", agentId);
    if (!a) throw fsError("EACCES", "unknown agent session");
    const us = this.#one("SELECT * FROM user_sessions WHERE id = ?", a.user_session) as Row;
    if (us.state !== "active") throw fsError("EACCES", "the user session was revoked");
    const chain: Row[] = [];
    for (
      let x: Row | undefined = a;
      x;
      x = x.parent ? this.#one("SELECT * FROM agent_sessions WHERE id = ?", x.parent) : undefined
    ) {
      if (x.state !== "active") throw fsError("EACCES", `agent session ${x.id} is ${x.state}`);
      chain.push(x);
    }
    const project = String(a.project);
    const segments = path.split("/").filter(Boolean);
    if (segments[1] === SYSTEM) throw fsError("ENOENT", `no such file or directory, '${path}'`);
    const role = await this.#role(project, String(us.user));
    if (!role) throw fsError("EACCES", `${us.user} is no longer a member of ${project}`);
    // The role's permissions, as Datalog over the capability (the token proves the session).
    const v = await Biscuit.fromBase64(await this.#capabilityFor(agentId)).verifyAsync(
      this.#root.public,
    );
    const allowed = v.authorize(
      `operation({op});\nresource({p});\nrole({role});\nroot({root});\ncheck if agent_session({id});\n${POLICY}`,
      {
        params: {
          op: action,
          p: path === "/" ? "/" : `${path}/`,
          role,
          root: `/${project}/`,
          id: agentId,
        },
      } as never,
    );
    if ((allowed as { kind: string }).kind !== "ok")
      throw fsError("EACCES", `the ${role} role may not ${action} '${path}'`);
    const modes = [
      String(us.mode),
      ...chain
        .map((x) => x.mode)
        .filter(Boolean)
        .map(String),
    ];
    const decision: Decision = strictest(modes.map((m) => MODES[m]?.[action] ?? "deny"));
    if (decision === "deny") throw fsError("EACCES", `mode ${modes.join(" + ")} denies ${action}`);
    return { decision: approved && decision === "ask" ? "allow" : decision, a, us };
  }

  /** The capability of an agent session, re-minted for the authorizer (same authority facts). */
  async #capabilityFor(agentId: string) {
    return Biscuit.build(this.#root.secret, `agent_session(${q(agentId)});`).toBase64();
  }

  async #run(method: string, path: string, args: unknown[], project: string): Promise<unknown> {
    // biome-ignore lint/suspicious/noExplicitAny: dispatch over the store's method table
    const store = this.#store as any;
    if (typeof store[method] !== "function") throw fsError("ENOSYS", `method '${method}'`);
    const out = await store[method](path, ...args);
    if (method === "readdir" && path === "/") return (out as string[]).filter((n) => n === project);
    if (method === "readdir" && path === `/${project}`)
      return (out as string[]).filter((n) => n !== SYSTEM);
    if (method === "readdirStat" && path === `/${project}`)
      return (out as { name: string }[]).filter((e) => e.name !== SYSTEM);
    return out;
  }

  /** One file call of an agent session: decided here, at the moment it happens. */
  async fsCall(
    capability: string,
    method: string,
    rawPath: string,
    args: unknown[] = [],
  ): Promise<unknown> {
    let action = ACTIONS[method];
    if (!action) throw fsError("ENOSYS", `method '${method}'`);
    const path = normalise(rawPath);
    // `mkdir -p` of a folder that exists changes nothing: it is not a write to ask about.
    if (method === "mkdir" && (await this.#store.exists(path))) action = "read";
    const agentId = await this.#agentOf(capability);
    const { decision, a, us } = await this.#decide(agentId, action, path, false);
    if (decision === "ask") {
      // The same action asked again (a tool retrying) waits on the same approval.
      const same = this.#one(
        "SELECT id FROM approvals WHERE agent_session = ? AND method = ? AND path = ? AND args = ? AND state = 'pending'",
        agentId,
        method,
        path,
        encode(args),
      );
      if (same) throw fsError("EACCES", `approval required: ${same.id}`);
      const id = `ap-${crypto.randomUUID()}`;
      this.#sql.exec(
        "INSERT INTO approvals VALUES (?, ?, ?, ?, ?, ?, 'pending', NULL, ?)",
        id,
        agentId,
        us.id,
        method,
        path,
        encode(args),
        Date.now(),
      );
      throw fsError("EACCES", `approval required: ${id}`);
    }
    return this.#run(method, path, args, String(a.project));
  }

  /** The user's answer. Approving re-checks the stored action now, then runs it. */
  async answer(
    accessToken: string,
    workspace: string,
    id: string,
    allow: boolean,
    reason?: string,
  ) {
    const us = await this.openUserSession(accessToken, workspace);
    const ap = this.#one(
      "SELECT * FROM approvals WHERE id = ? AND user_session = ? AND state = 'pending'",
      id,
      us.id,
    );
    if (!ap) throw fsError("ENOENT", "no pending approval");
    if (!allow) {
      this.#sql.exec(
        "UPDATE approvals SET state = 'denied', reason = ? WHERE id = ?",
        reason ?? null,
        id,
      );
      return { id, state: "denied" };
    }
    try {
      const { a } = await this.#decide(
        String(ap.agent_session),
        ACTIONS[String(ap.method)] as "write",
        String(ap.path),
        true,
      );
      await this.#run(
        String(ap.method),
        String(ap.path),
        decode(String(ap.args)),
        String(a.project),
      );
      this.#sql.exec("UPDATE approvals SET state = 'done' WHERE id = ?", id);
      return { id, state: "done" };
    } catch (e) {
      const message = String((e as Error).message);
      this.#sql.exec(
        "UPDATE approvals SET state = 'refused', reason = ? WHERE id = ?",
        message,
        id,
      );
      return { id, state: "refused", reason: message };
    }
  }

  // ---- admin -----------------------------------------------------------------------------------

  async seed(files: Record<string, string>) {
    for (const [p, text] of Object.entries(files)) await this.#store.writeFile(normalise(p), text);
    return Object.keys(files).length;
  }
  async setRole(
    project: string,
    user: string,
    role: string | null,
  ): Promise<Record<string, string>> {
    const file = `/${project}/${SYSTEM}/access`;
    const access = (await this.#store.exists(file))
      ? JSON.parse(await this.#store.readFile(file))
      : {};
    if (role) access[user] = role;
    else delete access[user];
    await this.#store.writeFile(file, JSON.stringify(access));
    return access;
  }
  async dump(path: string) {
    return (await this.#store.exists(path)) ? this.#store.readFile(path) : null;
  }
}
