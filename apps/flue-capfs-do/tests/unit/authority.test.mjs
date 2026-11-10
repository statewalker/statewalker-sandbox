// Runtime-free checks of the authorization core (Datalog policy, attenuation, revocation,
// verification caching) and the SQLite store, on node:sqlite. Node >= 22.18 strips the
// TypeScript types of the imported sources.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { Biscuit } from "@statewalker/webrun-biscuit";
import { Authority, FsGate } from "../../src/authority.ts";
import { attenuationBlock } from "../../src/policy.ts";
import { SqlFs } from "../../src/sql-fs.ts";

// ctx.storage.sql's exec(query, ...bindings) over node:sqlite.
function sql() {
  const db = new DatabaseSync(":memory:");
  return {
    exec(q, ...b) {
      const st = db.prepare(q);
      if (/^\s*(SELECT|WITH)/i.test(q)) {
        const rows = st.all(...b);
        return { toArray: () => rows };
      }
      st.run(...b);
      return { toArray: () => [] };
    },
  };
}

async function setup(rights = ["/p1", "/proj"], mode) {
  const s = sql();
  const store = new SqlFs(s);
  const auth = new Authority(s);
  for (const [p, c] of Object.entries({
    "/p1/a": "1",
    "/p10/b": "2",
    "/proj/x/y.md": "3",
    "/plans/p": "",
  }))
    await store.writeFile(p, c);
  const { session, token } = auth.startSession("alice", rights, mode);
  return { s, store, auth, session, token, gate: (t = token) => new FsGate(store, auth, t) };
}
const denied = (p) => assert.rejects(p, (e) => e.code === "EACCES");

test("exact prefixes and normalised paths", async () => {
  const { gate } = await setup();
  assert.equal(await gate().call("readFile", "/p1/a"), "1");
  await denied(gate().call("readFile", "/p10/b"));
  await denied(gate().call("readFile", "/p1/../p10/b"));
  await denied(gate().call("readFile", "/../../p10/b"));
  assert.deepEqual(await gate().readdir("/"), ["p1", "proj"]);
});

test("modes are read fresh on every call", async () => {
  const { gate, auth, session } = await setup(["/proj", "/plans"]);
  await gate().call("writeFile", "/proj/w", "x");
  auth.setMode(session, "plan");
  await denied(gate().call("writeFile", "/proj/w2", "x"));
  await gate().call("writeFile", "/plans/w", "x");
  auth.setMode(session, "prototyping");
  await gate().call("writeFile", "/proj/w3", "x");
  await denied(gate().call("writeFile", "/plans/w4", "x"));
  auth.setMode(session, "readonly");
  await denied(gate().call("mkdir", "/proj/d"));
  assert.throws(() => auth.setMode(session, "root"), /EINVAL/);
});

test("attenuation narrows, cannot widen, and lists only the scope's ancestors", async () => {
  const { gate, token } = await setup();
  const scoped = Biscuit.fromBase64(token)
    .attenuate(attenuationBlock({ scope: "/proj/x" }))
    .toBase64();
  assert.deepEqual(await gate(scoped).readdir("/"), ["proj"]);
  assert.deepEqual(await gate(scoped).readdir("/proj"), ["x"]);
  await gate(scoped).call("writeFile", "/proj/x/z", "ok");
  await denied(gate(scoped).call("readFile", "/p1/a"));
  await denied(gate(scoped).call("writeFile", "/proj/top", "no"));
  const ro = Biscuit.fromBase64(scoped)
    .attenuate(attenuationBlock({ readOnly: true }))
    .toBase64();
  assert.equal(await gate(ro).call("readFile", "/proj/x/y.md"), "3");
  await denied(gate(ro).call("writeFile", "/proj/x/z", "no"));
  await denied(gate(ro).move("cp", "/proj/x/y.md", "/proj/x/c"));
  const widened = Biscuit.fromBase64(token).attenuate(`right("/");`).toBase64();
  await denied(gate(widened).call("readFile", "/p10/b"));
  const two = Biscuit.fromBase64(token)
    .attenuate(attenuationBlock({ scope: ["/p1", "/proj/x"] }))
    .toBase64();
  assert.deepEqual(await gate(two).readdir("/"), ["p1", "proj"]);
});

test("cp/mv need read on the source and write on both ends", async () => {
  const { gate, store } = await setup();
  await gate().move("cp", "/p1/a", "/proj/a-copy");
  assert.equal(await store.readFile("/proj/a-copy"), "1");
  await denied(gate().move("cp", "/p10/b", "/proj/stolen"));
  await denied(gate().move("mv", "/proj/a-copy", "/p10/moved"));
  await gate().move("mv", "/proj/a-copy", "/p1/moved");
  assert.equal(await store.exists("/proj/a-copy"), false);
});

test("revocation: one capability and its descendants, or the whole session", async () => {
  const { gate, auth, session, token } = await setup();
  const child = Biscuit.fromBase64(token)
    .attenuate(attenuationBlock({ scope: "/proj" }))
    .toBase64();
  const grandchild = Biscuit.fromBase64(child)
    .attenuate(attenuationBlock({ readOnly: true }))
    .toBase64();
  auth.revoke(session, (await auth.revocationIds(child)).at(-1));
  await denied(gate(child).call("readFile", "/proj/x/y.md"));
  await denied(gate(grandchild).call("readFile", "/proj/x/y.md"));
  assert.equal(await gate().call("readFile", "/p1/a"), "1");
  auth.revoke(session);
  await denied(gate().call("readFile", "/p1/a"));
});

test("tokens: forged, other session, unknown session", async () => {
  const a = await setup();
  const b = await setup(["/"]);
  await denied(a.gate(b.token).call("readFile", "/p1/a")); // other root key
  const { token: other } = a.auth.startSession("bob", ["/p10"]);
  assert.equal(await a.gate(other).call("readFile", "/p10/b"), "2");
  await denied(a.gate(other).call("readFile", "/p1/a"));
});

test("verification is cached per token; the root key survives a restart", async () => {
  const { s, store, auth, token } = await setup();
  const g = new FsGate(store, auth, token);
  for (let i = 0; i < 20; i++) await g.call("readFile", "/p1/a");
  assert.equal(auth.stats.verifications, 1);
  assert.ok(auth.stats.authorizations >= 20);
  const again = new Authority(s); // same SQLite: same key, same sessions
  assert.equal(await new FsGate(store, again, token).call("readFile", "/p1/a"), "1");
});

test("SqlFs: directories, rm, errors carry codes", async () => {
  const { store } = await setup();
  await store.mkdir("/d/e", { recursive: true });
  await assert.rejects(store.mkdir("/d"), (e) => e.code === "EEXIST");
  await assert.rejects(store.readFile("/d"), (e) => e.code === "EISDIR");
  await assert.rejects(store.readFile("/nope"), (e) => e.code === "ENOENT");
  await store.writeFile("/d/e/f", "x");
  await assert.rejects(store.rm("/d"), (e) => e.code === "ENOTEMPTY");
  await store.rm("/d", { recursive: true });
  assert.equal(await store.exists("/d/e/f"), false);
  await store.writeFile("/a_b/x", "1");
  await store.writeFile("/aXb/y", "2");
  await store.rm("/a_b", { recursive: true });
  assert.equal(await store.exists("/aXb/y"), true, "LIKE wildcards are escaped");
});

// ---- regressions from the PR #41 review ----

test("rm -r is case-sensitive: /HR never deletes /hr", async () => {
  const s = sql();
  const store = new SqlFs(s);
  const auth = new Authority(s);
  await store.writeFile("/hr/salaries.csv", "secret");
  await store.writeFile("/hr/sub/x", "secret");
  const { token } = auth.startSession("mallory", ["/HR"]);
  const g = new FsGate(store, auth, token);
  await g.call("mkdir", "/HR", {});
  await g.call("rm", "/HR", { recursive: true });
  assert.equal(await store.readFile("/hr/salaries.csv"), "secret");
  assert.equal(await store.readFile("/hr/sub/x"), "secret");
});

test("recursive cp/mv/rm authorize every entry (non-prefix attenuation holds)", async () => {
  const { gate, token, store } = await setup();
  await store.writeFile("/proj/secret/k", "KEY");
  const noSecret = Biscuit.fromBase64(token)
    .attenuate(`check if resource($p), !$p.starts_with("/proj/secret/");`)
    .toBase64();
  await denied(gate(noSecret).call("readFile", "/proj/secret/k"));
  await denied(gate(noSecret).move("cp", "/proj", "/p1/copy", { recursive: true }));
  assert.equal(await store.exists("/p1/copy"), false);
  await denied(gate(noSecret).move("mv", "/proj", "/p1/moved"));
  await denied(gate(noSecret).call("rm", "/proj", { recursive: true }));
  assert.equal(await store.readFile("/proj/secret/k"), "KEY");
  // without the secret subtree the same operations work
  await gate(noSecret).move("cp", "/proj/x", "/p1/copy", { recursive: true });
  assert.equal(await store.readFile("/p1/copy/y.md"), "3");
});

test("cp/mv into itself is refused, mv onto itself keeps the file, cp -r merges", async () => {
  const { gate, store } = await setup();
  await assert.rejects(
    gate().move("cp", "/proj", "/proj/inner", { recursive: true }),
    (e) => e.code === "EINVAL",
  );
  await assert.rejects(gate().move("mv", "/proj", "/proj/x/inner"), (e) => e.code === "EINVAL");
  await gate().move("mv", "/proj/x/y.md", "/proj/x/y.md");
  await gate().move("mv", "/proj/x/y.md", "/proj/x"); // "into" its own directory: same path
  assert.equal(await store.readFile("/proj/x/y.md"), "3");
  await store.mkdir("/proj/b");
  await gate().move("cp", "/proj/x", "/proj/b", { recursive: true });
  await gate().move("cp", "/proj/x", "/proj/b", { recursive: true });
  assert.deepEqual(
    (await store.entries("/proj/b")).map((e) => e.path),
    ["/proj/b", "/proj/b/x", "/proj/b/x/y.md"],
  );
});

test("writes do not create parent directories outside the rights", async () => {
  const s = sql();
  const store = new SqlFs(s);
  const auth = new Authority(s);
  const { token } = auth.startSession("alice", ["/q/r"]);
  const g = new FsGate(store, auth, token);
  await denied(g.call("writeFile", "/q/r/f", "x")); // would create /q
  assert.equal(await store.exists("/q"), false);
  await store.mkdir("/q/r", { recursive: true }); // what Workspace.startSession does
  await g.call("writeFile", "/q/r/sub/f", "x");
  assert.equal(await store.readFile("/q/r/sub/f"), "x");
});

test("mkdir under a file is ENOTDIR; methods are looked up on own properties only", async () => {
  const { gate, store } = await setup();
  await assert.rejects(store.mkdir("/p1/a/sub"), (e) => e.code === "ENOTDIR");
  for (const m of ["toString", "constructor", "__proto__"]) {
    await assert.rejects(gate().call(m, "/p1/a"), (e) => e.code === "ENOSYS");
  }
});

test("a capability already handed out sees mode switches and revocation on its next call", async () => {
  const { gate, auth, session } = await setup();
  const g = gate(); // one long-lived gate, like a stub held by another cell
  await g.call("writeFile", "/proj/w", "1");
  auth.setMode(session, "readonly");
  await denied(g.call("writeFile", "/proj/w", "2"));
  assert.equal(await g.call("readFile", "/proj/w"), "1");
  auth.setMode(session, "yolo");
  await g.call("writeFile", "/proj/w", "3");
  auth.revoke(session);
  await denied(g.call("readFile", "/proj/w"));
});

test("admin input is validated", async () => {
  const { auth, session } = await setup();
  assert.throws(() => auth.revoke(session, "not-a-revocation-id"), /EINVAL/);
  assert.throws(() => auth.startSession("bob", "/p1"), /EINVAL/);
  assert.throws(() => auth.startSession("", ["/p1"]), /EINVAL/);
});

test("model: a right of the session, narrowed by attenuation, read fresh on revocation", async () => {
  const { s, store, auth } = await setup();
  const gateOf = (t) => new FsGate(store, auth, t);
  const without = auth.startSession("bob", ["/proj"]).token;
  await denied(gateOf(without).model("grant", true));
  const { session, token } = auth.startSession("carol", ["/proj"], "readonly", true);
  assert.deepEqual(await gateOf(token).model("grant", true), { turnsLeft: null, tokensLeft: null });
  const t = (datalog) => Biscuit.fromBase64(token).attenuate(datalog).toBase64();
  // Files-only attenuations keep the model; NO_MODEL drops it; a custom check can too.
  await gateOf(t(attenuationBlock({ readOnly: true, scope: "/proj/x" }))).model("grant", true);
  await denied(gateOf(t(attenuationBlock({ noModel: true }))).model("grant", true));
  await denied(gateOf(t(`check if operation($o), ["read"].contains($o);`)).model("grant", true));
  // A model token never opens files: the right is not a path.
  await denied(gateOf(token).call("readFile", "/p1/a"));
  auth.revoke(session);
  await denied(gateOf(token).model("grant", true));
  assert.ok(s);
});

test("model: a budget is charged per turn and tokens, and refuses a metered run once spent", async () => {
  const { store, auth } = await setup();
  const { session, token } = auth.startSession("dave", ["/proj"], "yolo", {
    turns: 2,
    tokens: 100,
  });
  const g = new FsGate(store, auth, token);
  assert.deepEqual(await g.model("grant", true), { turnsLeft: 2, tokensLeft: 100 });
  let r = await g.model("charge", true, { turns: 1, input: 30, output: 10 });
  assert.deepEqual(r, { turnsLeft: 1, tokensLeft: 60, spent: false });
  // Not metered (a caller's own token): recorded, not charged.
  r = await g.model("charge", false, { turns: 1, input: 500, output: 0 });
  assert.equal(r.tokensLeft, 60);
  r = await g.model("charge", true, { turns: 1, input: 70, output: 0 });
  assert.deepEqual(r, { turnsLeft: 0, tokensLeft: 0, spent: true });
  await denied(g.model("grant", true));
  assert.deepEqual(await g.model("grant", false), { turnsLeft: 0, tokensLeft: 0 });
  const info = auth.sessionInfo(session).model;
  assert.deepEqual(info.used, { turns: 3, input: 600, output: 10 });
  auth.setModelBudget(session, { turns: 5 });
  assert.deepEqual(await g.model("grant", true), { turnsLeft: 5, tokensLeft: null });
  assert.throws(() => auth.setModelBudget(session, { turns: -1 }), /EINVAL/);
  assert.throws(() => auth.startSession("e", ["/"], "yolo", "yes"), /EINVAL/);
});
