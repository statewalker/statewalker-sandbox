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
