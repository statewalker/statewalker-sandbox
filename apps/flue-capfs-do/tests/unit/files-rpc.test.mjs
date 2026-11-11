// The files RPC between holders and the Workspace: FilesRpcHub (a webrun-files-rpc server per
// capability token, serving GuardedFilesApi) and capFiles (the client over a capability), on the
// real Authority, FsGate and SqlFs over node:sqlite.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Biscuit } from "@statewalker/webrun-biscuit";
import { Authority, FsGate } from "../../src/authority.ts";
import { capFiles, capFilesRpc } from "../../src/files-rpc.ts";
import { FilesRpcHub } from "../../src/files-rpc-hub.ts";
import { rebuildError } from "../../src/path.ts";
import { attenuationBlock } from "../../src/policy.ts";
import { BLOCK_BYTES, SqlFs, STREAM_IDLE_MS } from "../../src/sql-fs.ts";
import { sql } from "../helpers/sql.mjs";

async function setup(rights = ["/p1", "/proj"]) {
  const s = sql();
  const store = new SqlFs(s);
  const auth = new Authority(s);
  for (const [p, c] of Object.entries({ "/p1/a": "1", "/p10/b": "2", "/proj/x/y.md": "3" }))
    await store.writeFile(p, c);
  const { session, token } = auth.startSession("alice", rights);
  const hub = new FilesRpcHub(store, auth);
  // What a capability carries: cloned both ways, errors rebuilt, as over Durable Object RPC.
  const carrier = (t = token) => ({
    rpc: (m, a) =>
      hub.call(t, m, structuredClone(a)).then(structuredClone, (e) => {
        throw rebuildError(structuredClone(e));
      }),
  });
  const files = (t = token) => capFiles(carrier(t));
  const rpc = (t = token) => capFilesRpc(carrier(t));
  const blocks = () => Number(s.exec("SELECT count(*) AS n FROM fs_blocks").toArray()[0].n);
  return { s, store, auth, session, token, hub, carrier, files, rpc, blocks };
}
const pattern = (n, seed = 1) => {
  const b = new Uint8Array(n);
  let x = seed;
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) >>> 0;
    b[i] = x >>> 24;
  }
  return b;
};
const collect = async (it) => {
  const parts = [];
  for await (const c of it) parts.push(c);
  return Buffer.concat(parts);
};
const code = (c) => (e) => e.code === c || String(e.message).startsWith(`${c}:`);
const ID = "0123456789abcdef0123";

test("a file of several blocks goes through the files RPC both ways, in 1 MiB chunks", async () => {
  const { files, rpc, hub } = await setup();
  const data = pattern(3 * BLOCK_BYTES + 77);
  await files().write("/p1/big.bin", [data.subarray(0, 5), data.subarray(5)]);
  assert.ok((await collect(files().read("/p1/big.bin"))).equals(Buffer.from(data)));
  const range = await collect(files().read("/p1/big.bin", { start: BLOCK_BYTES - 3, length: 10 }));
  assert.ok(range.equals(Buffer.from(data.subarray(BLOCK_BYTES - 3, BLOCK_BYTES + 7))));
  // By hand: chunk k is the k-th MiB.
  const { streamId } = await rpc().openRead("/p1/big.bin");
  const c2 = await rpc().readChunk(streamId, 2);
  assert.equal(c2.data.length, BLOCK_BYTES);
  assert.equal((await rpc().readChunk(streamId, 3)).done, true);
  await rpc().closeRead(streamId);
  assert.equal(hub.openStreams(), 0);
  assert.equal(hub.servers, 1, "one server for the one capability");
});

test("the capability's `call` no longer carries the store's stream methods", async () => {
  const { store, auth, token } = await setup();
  const gate = new FsGate(store, auth, token);
  for (const m of [
    "openRead",
    "readChunk",
    "closeRead",
    "openWrite",
    "writeChunk",
    "commitWrite",
    "abortWrite",
  ])
    await assert.rejects(gate.call(m, "/p1/a", {}), code("ENOSYS"), m);
});

test("only the files-RPC methods are answered; arguments are an array", async () => {
  const { hub, token } = await setup();
  for (const m of ["sweep", "close", "openStreams", "constructor", "__proto__", "toString", 7])
    await assert.rejects(hub.call(token, m, []), code("ENOSYS"), String(m));
  await assert.rejects(hub.call(token, "stats", "/p1/a"), code("EINVAL"));
  assert.deepEqual(await hub.call(token, "exists", ["/p1/a"]), true);
});

test("a forged token gets no server", async () => {
  const { hub } = await setup();
  const forged = Biscuit.fromBase64((await setup()).token).toBase64(); // another workspace's key
  await assert.rejects(hub.call(forged, "exists", ["/p1/a"]));
  await assert.rejects(hub.call("garbage", "exists", ["/p1/a"]));
  assert.equal(hub.servers, 0);
});

test("a stream belongs to the capability that opened it, even with a stream id it chose", async () => {
  const { auth, rpc, store } = await setup();
  await store.writeFile("/p1/f", "alice's");
  const bob = auth.startSession("bob", ["/p10"]).token;
  await rpc().openRead("/p1/f", { streamId: ID });
  await assert.rejects(rpc(bob).readChunk(ID, 0), code("UNKNOWN_STREAM"));
  // The same id opened by bob is bob's own stream, of what bob may read.
  await rpc(bob).openRead("/p10/b", { streamId: ID });
  assert.equal(new TextDecoder().decode((await rpc(bob).readChunk(ID, 0)).data), "2");
  assert.equal(new TextDecoder().decode((await rpc().readChunk(ID, 0)).data), "alice's");
});

test("rights hold on every operation: listing, reading, writing, removing", async () => {
  const { files, token } = await setup();
  const top = [];
  for await (const e of files().list("/")) top.push(e.path);
  assert.deepEqual(top, ["/p1", "/proj"], "/p10 is not visible");
  await assert.rejects(collect(files().read("/p10/b")), code("EACCES"));
  await assert.rejects(files().write("/p10/c", [pattern(10)]), code("EACCES"));
  await assert.rejects(files().remove("/p10/b"), code("EACCES"));
  const ro = Biscuit.fromBase64(token)
    .attenuate(attenuationBlock({ readOnly: true }))
    .toBase64();
  assert.equal((await collect(files(ro).read("/p1/a"))).toString(), "1");
  await assert.rejects(files(ro).write("/p1/a", [pattern(10)]), code("EACCES"));
  await assert.rejects(files(ro).mkdir("/p1/d"), code("EACCES"));
  assert.equal((await collect(files().read("/p1/a"))).toString(), "1");
});

test("a revocation stops a stream between two chunks; nothing stays held", async () => {
  const { files, auth, session, hub, store, blocks } = await setup();
  await files().write("/p1/big", [pattern(8 * BLOCK_BYTES)]);
  const it = files().read("/p1/big")[Symbol.asyncIterator]();
  assert.equal((await it.next()).value.length, BLOCK_BYTES);
  auth.revoke(session);
  await assert.rejects(
    (async () => {
      for (;;) if ((await it.next()).done) break;
    })(),
    code("EACCES"),
  );
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(hub.openStreams(), 0, "the failed stream is gone");
  // No pin left: removing the file frees its blocks.
  const n = blocks();
  await store.rm("/p1/big");
  assert.equal(blocks(), n - 8);
});

test("a write that fails or is cut off changes nothing and leaves no blocks", async () => {
  const { files, hub, blocks } = await setup();
  await files().write("/p1/f", [new TextEncoder().encode("old")]);
  const before = blocks();
  async function* failing() {
    yield pattern(BLOCK_BYTES);
    yield pattern(BLOCK_BYTES, 2);
    throw new Error("source broke");
  }
  await assert.rejects(files().write("/p1/f", failing()), /source broke/);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal((await collect(files().read("/p1/f"))).toString(), "old");
  assert.equal(hub.openStreams(), 0);
  assert.equal(blocks(), before);
});

test("streams per capability are bounded; another capability still has room", async () => {
  const { files, rpc, auth } = await setup();
  await files().write("/p1/big", [pattern(4 * BLOCK_BYTES)]);
  const ids = [];
  for (let i = 0; i < 16; i++) ids.push((await rpc().openRead("/p1/big")).streamId);
  await assert.rejects(rpc().openRead("/p1/big"), code("TOO_MANY_STREAMS"));
  const bob = auth.startSession("bob", ["/p1"]).token;
  const b = await rpc(bob).openRead("/p1/big");
  await rpc(bob).closeRead(b.streamId);
  for (const id of ids) await rpc().closeRead(id);
  assert.ok(await rpc().openRead("/p1/big"));
});

test("servers per workspace are bounded (least recently used, idle first, go)", async () => {
  const { hub, auth, token } = await setup();
  const { streamId } = await hub.call(token, "openRead", ["/p1/a"]);
  for (let i = 0; i < 70; i++)
    await hub.call(auth.startSession(`u${i}`, ["/p1"]).token, "exists", ["/p1/a"]);
  assert.equal(hub.servers, 64);
  // The busy server was kept over idle ones.
  assert.equal(
    new TextDecoder().decode((await hub.call(token, "readChunk", [streamId, 0])).data),
    "1",
  );
});

test("idle streams are dropped (reads let go of their content, writes of their blocks)", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  const { files, rpc, hub, blocks, store } = await setup();
  await files().write("/p1/big", [pattern(3 * BLOCK_BYTES)]);
  const n = blocks();
  const r = await rpc().openRead("/p1/big");
  await rpc().readChunk(r.streamId, 0);
  const w = await rpc().openWrite("/p1/new");
  await rpc().writeChunk(w.streamId, 0, pattern(BLOCK_BYTES));
  await new Promise((res) => setTimeout(res, 10));
  await store.rm("/p1/big"); // the reader still holds the content
  assert.equal(blocks(), n + 1, "the content, held, and the staged block");
  t.mock.timers.tick(STREAM_IDLE_MS + 10_000);
  await rpc().exists("/p1/a"); // any call sweeps
  await new Promise((res) => setTimeout(res, 10));
  assert.equal(hub.openStreams(), 0);
  await assert.rejects(rpc().readChunk(r.streamId, 1), code("UNKNOWN_STREAM"));
  // The store let go too: the next stream call sweeps it; the content and the staged blocks go.
  await rpc()
    .openRead("/p1/a")
    .then((o) => rpc().closeRead(o.streamId));
  assert.equal(blocks(), n - 3);
  assert.equal(await files().exists("/p1/new"), false);
});
