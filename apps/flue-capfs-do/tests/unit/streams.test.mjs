// The store's streams (FsGate.stream, owner side), its blocks, and the holder's FilesApi
// (capFiles: the files-RPC client over the capability, answered by the Workspace's FilesRpcHub),
// on the real Authority, FsGate and SqlFs over node:sqlite.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Biscuit } from "@statewalker/webrun-biscuit";
import { Authority, FsGate } from "../../src/authority.ts";
import { capFiles } from "../../src/files-rpc.ts";
import { FilesRpcHub } from "../../src/files-rpc-hub.ts";
import { rebuildError } from "../../src/path.ts";
import { attenuationBlock } from "../../src/policy.ts";
import { BLOCK_BYTES, MAX_WHOLE_FILE_BYTES, SqlFs, STREAM_IDLE_MS } from "../../src/sql-fs.ts";
import { sql } from "../helpers/sql.mjs";

async function setup(rights = ["/p1", "/proj"]) {
  const s = sql();
  const store = new SqlFs(s);
  const auth = new Authority(s);
  for (const [p, c] of Object.entries({ "/p1/a": "1", "/p10/b": "2", "/proj/x/y.md": "3" }))
    await store.writeFile(p, c);
  const { session, token } = auth.startSession("alice", rights);
  const gate = (t = token) => new FsGate(store, auth, t);
  const hub = new FilesRpcHub(store, auth);
  // A capability as holders see it (what StubCap/TokenCap provide), over the gate and the hub;
  // files-RPC arguments and results are cloned, as Durable Object RPC does.
  const cap = (t = token) => ({
    call: (m, p, ...a) => gate(t).call(m, p, ...a),
    readdir: (p) => gate(t).readdir(p),
    move: (k, a, b, o) => gate(t).move(k, a, b, o),
    rpc: (m, a) =>
      hub.call(t, m, structuredClone(a)).then(structuredClone, (e) => {
        throw rebuildError(structuredClone(e));
      }),
  });
  const blocks = () => Number(s.exec("SELECT count(*) AS n FROM fs_blocks").toArray()[0].n);
  return { s, store, auth, session, token, gate, hub, cap, blocks };
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
/** Sends `bytes` in chunks of at most one block, as GuardedFilesApi does. */
async function writeAll(gate, path, id, bytes) {
  for (let at = 0; at < bytes.length; at += BLOCK_BYTES)
    await gate.stream("writeChunk", path, id, bytes.slice(at, at + BLOCK_BYTES));
}

test("a 5 MB file streams in and out in chunks; ranges; whole-file calls stop at 16 MiB", async () => {
  const { gate, cap, s } = await setup();
  const files = capFiles(cap());
  const data = pattern(5 * 1024 * 1024 + 123);
  // Odd-sized input chunks: the store cuts blocks itself.
  const parts = [data.subarray(0, 7), data.subarray(7, 3_000_001), data.subarray(3_000_001)];
  await files.write("/p1/big.bin", parts);
  assert.deepEqual(await files.stats("/p1/big.bin"), {
    kind: "file",
    size: data.length,
    lastModified: (await files.stats("/p1/big.bin")).lastModified,
  });
  const back = await collect(files.read("/p1/big.bin"));
  assert.ok(Buffer.from(data).equals(back));
  // Every block is one row under the limit.
  const rows = s
    .exec(
      "SELECT max(length(data)) AS m, count(*) AS n FROM fs_blocks WHERE content = (SELECT content FROM fs_entries WHERE path = '/p1/big.bin')",
    )
    .toArray()[0];
  assert.equal(Number(rows.m), BLOCK_BYTES);
  assert.equal(Number(rows.n), Math.ceil(data.length / BLOCK_BYTES));
  // Ranges, across block boundaries.
  for (const [start, length] of [
    [0, 10],
    [BLOCK_BYTES - 5, 10],
    [3 * BLOCK_BYTES + 1, 2 * BLOCK_BYTES],
    [data.length - 3, 100],
    [data.length + 10, 5],
  ]) {
    const got = await collect(files.read("/p1/big.bin", { start, length }));
    assert.ok(Buffer.from(data.subarray(start, start + length)).equals(got), `${start}+${length}`);
  }
  // A file that does not exist reads as nothing.
  assert.equal((await collect(files.read("/p1/none"))).length, 0);
  // Whole-file calls move at most MAX_WHOLE_FILE_BYTES.
  await files.write("/p1/huge.bin", [new Uint8Array(MAX_WHOLE_FILE_BYTES + 1)]);
  await assert.rejects(gate().call("readFileBuffer", "/p1/huge.bin"), code("EFBIG"));
  await assert.rejects(
    gate().call("writeFileBuffer", "/p1/w.bin", new Uint8Array(MAX_WHOLE_FILE_BYTES + 1)),
    code("EFBIG"),
  );
  assert.equal((await gate().call("stat", "/p1/huge.bin")).size, MAX_WHOLE_FILE_BYTES + 1);
});

test("a write shows only at commit; abort, expiry and a restart leave no blocks", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  const { gate, cap, store, s, blocks } = await setup();
  await gate().call("writeFile", "/p1/f", "old");
  const before = blocks();
  const { id } = await gate().stream("openWrite", "/p1/f", {});
  await writeAll(gate(), "/p1/f", id, pattern(BLOCK_BYTES + 10));
  assert.equal(await gate().call("readFile", "/p1/f"), "old", "not before commit");
  await gate().stream("abortWrite", "/p1/f", id);
  assert.equal(blocks(), before);
  await assert.rejects(gate().stream("writeChunk", "/p1/f", id, new Uint8Array(1)), code("EBADF"));
  // Expiry: an idle stream is dropped with its blocks.
  const w = await gate().stream("openWrite", "/p1/g", {});
  await writeAll(gate(), "/p1/g", w.id, pattern(BLOCK_BYTES * 2));
  t.mock.timers.tick(STREAM_IDLE_MS + 1);
  await gate().stream("openWrite", "/p1/h", {}); // any stream call sweeps
  assert.equal(blocks(), before);
  await assert.rejects(gate().stream("commitWrite", "/p1/g", w.id), code("EBADF"));
  assert.equal(await store.exists("/p1/g"), false);
  // A restart drops blocks of writes that never committed.
  const x = await gate().stream("openWrite", "/p1/x", {});
  await writeAll(gate(), "/p1/x", x.id, pattern(BLOCK_BYTES * 2));
  assert.ok(blocks() > before);
  new SqlFs(s);
  assert.equal(blocks(), before);
  void cap;
});

test("a reader keeps the content it opened; overwrites, removals and copies share or free blocks", async () => {
  const { gate, cap, blocks } = await setup();
  const files = capFiles(cap());
  const seeded = blocks();
  const one = pattern(2 * BLOCK_BYTES, 1);
  await files.write("/p1/f", [one]);
  const { id, size } = await gate().stream("openRead", "/p1/f", {});
  assert.equal(size, one.length);
  const first = await gate().stream("readChunk", "/p1/f", id, 1000);
  await files.write("/p1/f", [pattern(10, 2)]); // overwritten while being read
  await gate().call("rm", "/p1/f");
  const rest = [];
  for (;;) {
    const c = await gate().stream("readChunk", "/p1/f", id, BLOCK_BYTES);
    if (!c.byteLength) break;
    rest.push(new Uint8Array(c));
  }
  assert.ok(Buffer.concat([new Uint8Array(first), ...rest]).equals(Buffer.from(one)));
  await gate().stream("closeRead", "/p1/f", id);
  assert.equal(blocks(), seeded, "nothing refers to the old content any more");
  // A copy shares blocks; removing one copy keeps them for the other.
  await files.write("/p1/a", [one]);
  const n = blocks();
  await files.copy("/p1/a", "/proj/b");
  assert.equal(blocks(), n);
  await files.remove("/p1/a");
  assert.equal(blocks(), n);
  assert.ok((await collect(files.read("/proj/b"))).equals(Buffer.from(one)));
  await files.move("/proj/b", "/proj/c");
  assert.equal(blocks(), n);
  await files.remove("/proj");
  assert.equal(blocks(), seeded - 2, "the seeded /p1/a and /proj/x/y.md are gone too");
});

test("a stream belongs to the capability that opened it; rights are checked on every chunk", async () => {
  const { gate, token, auth, session } = await setup();
  await gate().call("writeFile", "/p1/f", "secret");
  const other = auth.startSession("bob", ["/p1"]).token;
  const { id } = await gate().stream("openRead", "/p1/f", {});
  await assert.rejects(gate(other).stream("readChunk", "/p1/f", id, 10), code("EBADF"));
  await assert.rejects(
    gate().stream("readChunk", "/p1/a", id, 10),
    code("EBADF"),
    "same path only",
  );
  // Reading needs read, writing needs write, opening outside the rights is refused.
  await assert.rejects(gate().stream("openRead", "/p10/b", {}), code("EACCES"));
  const ro = Biscuit.fromBase64(token)
    .attenuate(attenuationBlock({ readOnly: true }))
    .toBase64();
  await assert.rejects(gate(ro).stream("openWrite", "/p1/f", {}), code("EACCES"));
  const w = await gate().stream("openWrite", "/p1/new/deep.bin", {});
  await gate().stream("writeChunk", "/p1/new/deep.bin", w.id, new Uint8Array([1, 2]));
  // Revoked between two chunks: the next one is refused.
  auth.revoke(session);
  await assert.rejects(gate().stream("readChunk", "/p1/f", id, 10), code("EACCES"));
  await assert.rejects(gate().stream("commitWrite", "/p1/new/deep.bin", w.id), code("EACCES"));
});

test("append streams and appendFile share the full blocks; rows from before blocks still stream", async () => {
  const { gate, cap, s, store } = await setup();
  const files = capFiles(cap());
  const a = pattern(BLOCK_BYTES + 5, 3);
  await files.write("/p1/log", [a]);
  const w = await gate().stream("openWrite", "/p1/log", { append: true });
  await gate().stream("writeChunk", "/p1/log", w.id, new Uint8Array([7, 8, 9]));
  await gate().stream("commitWrite", "/p1/log", w.id);
  await gate().call("appendFileBuffer", "/p1/log", new Uint8Array([10]));
  assert.ok(
    (await collect(files.read("/p1/log"))).equals(Buffer.concat([a, Buffer.from([7, 8, 9, 10])])),
  );
  // A row written before blocks (content in fs_entries.data) reads, streams and appends.
  s.exec(
    "UPDATE fs_entries SET data = ?, content = NULL, size = NULL WHERE path = '/p1/a'",
    "legacy",
  );
  assert.equal(await store.readFile("/p1/a"), "legacy");
  assert.equal((await collect(files.read("/p1/a", { start: 2 }))).toString(), "gacy");
  await store.appendFile("/p1/a", "!");
  assert.equal(await store.readFile("/p1/a"), "legacy!");
  assert.equal((await files.stats("/p1/a")).size, 7);
});

test("capFiles: list in path order (recursive, after), stats, exists, mkdir, remove", async () => {
  const { cap } = await setup();
  const files = capFiles(cap());
  await files.mkdir("/proj/d/e");
  await files.write("/proj/d/z.txt", [new TextEncoder().encode("z")]);
  await files.write("/proj/d/e/a.txt", [new TextEncoder().encode("aa")]);
  const all = [];
  for await (const e of files.list("/proj", { recursive: true })) all.push([e.path, e.kind]);
  assert.deepEqual(all, [
    ["/proj/d", "directory"],
    ["/proj/d/e", "directory"],
    ["/proj/d/e/a.txt", "file"],
    ["/proj/d/z.txt", "file"],
    ["/proj/x", "directory"],
    ["/proj/x/y.md", "file"],
  ]);
  const after = [];
  for await (const e of files.list("/proj", { recursive: true, after: "/proj/d/e/a.txt" }))
    after.push(e.path);
  assert.deepEqual(after, ["/proj/d/z.txt", "/proj/x", "/proj/x/y.md"]);
  const top = [];
  for await (const e of files.list("/proj/d")) top.push(e.name);
  assert.deepEqual(top, ["e", "z.txt"]);
  assert.equal((await files.stats("/proj/d/e/a.txt")).size, 2);
  assert.equal((await files.stats("/proj/d")).kind, "directory");
  assert.equal(await files.exists("/proj/nope"), false);
  assert.equal(await files.remove("/proj/nope"), false);
  assert.equal(await files.remove("/proj/d"), true);
  assert.equal(await files.exists("/proj/d/z.txt"), false);
});

test("appends change the last block in place when the file alone owns its content", async () => {
  const { gate, cap, s } = await setup();
  const files = capFiles(cap());
  await files.write("/p1/log", [pattern(3 * BLOCK_BYTES + 10)]);
  const contentOf = () =>
    Number(s.exec("SELECT content FROM fs_entries WHERE path = '/p1/log'").toArray()[0].content);
  const rows = () =>
    Number(
      s.exec("SELECT count(*) AS n FROM fs_blocks WHERE content = ?", contentOf()).toArray()[0].n,
    );
  const before = contentOf();
  for (let i = 0; i < 5; i++) await gate().call("appendFile", "/p1/log", "x");
  assert.equal(contentOf(), before, "no copy");
  assert.equal(rows(), 4);
  // An append stream commits in place too.
  const w = await gate().stream("openWrite", "/p1/log", { append: true });
  await gate().stream("writeChunk", "/p1/log", w.id, pattern(BLOCK_BYTES, 9));
  await gate().stream("commitWrite", "/p1/log", w.id);
  assert.equal(contentOf(), before);
  const expect = Buffer.concat([
    pattern(3 * BLOCK_BYTES + 10),
    Buffer.from("xxxxx"),
    pattern(BLOCK_BYTES, 9),
  ]);
  assert.ok((await collect(files.read("/p1/log"))).equals(expect));
  // A file sharing its content with a copy, or held by a reader, is appended to in a copy.
  await files.copy("/p1/log", "/proj/copy");
  await gate().call("appendFile", "/p1/log", "!");
  assert.notEqual(contentOf(), before);
  assert.ok((await collect(files.read("/proj/copy"))).equals(expect), "the copy keeps its content");
});

test("an append stream fails at commit if the file changed meanwhile (ESTALE)", async () => {
  const { gate } = await setup();
  await gate().call("writeFile", "/p1/f", "abc");
  const w = await gate().stream("openWrite", "/p1/f", { append: true });
  await gate().stream("writeChunk", "/p1/f", w.id, new TextEncoder().encode("1"));
  await gate().call("appendFile", "/p1/f", "2");
  await assert.rejects(gate().stream("commitWrite", "/p1/f", w.id), code("ESTALE"));
  assert.equal(await gate().call("readFile", "/p1/f"), "abc2");
});

test("bounds: one block per chunk, 32 streams per capability, no pin left by EMFILE", async () => {
  const { gate, auth, blocks } = await setup();
  await gate().call("writeFile", "/p1/f", "x");
  const w = await gate().stream("openWrite", "/p1/w", {});
  await assert.rejects(
    gate().stream("writeChunk", "/p1/w", w.id, new Uint8Array(BLOCK_BYTES + 1)),
    code("EINVAL"),
  );
  await gate().stream("abortWrite", "/p1/w", w.id);
  const ids = [];
  for (let i = 0; i < 32; i++) ids.push((await gate().stream("openRead", "/p1/f", {})).id);
  await assert.rejects(gate().stream("openRead", "/p1/f", {}), code("EMFILE"));
  // Another capability still has room.
  const other = auth.startSession("bob", ["/p1"]).token;
  const o = await gate(other).stream("openRead", "/p1/f", {});
  await gate(other).stream("closeRead", "/p1/f", o.id);
  for (const id of ids) await gate().stream("closeRead", "/p1/f", id);
  const n = blocks();
  await gate().call("rm", "/p1/f");
  assert.equal(blocks(), n - 1, "the file's block went with it: no pin was left behind");
});

test("a revoked capability can still release its streams", async () => {
  const { gate, auth, session, blocks } = await setup();
  await gate().call("writeFile", "/p1/f", "x");
  const n = blocks();
  const r = await gate().stream("openRead", "/p1/f", {});
  const w = await gate().stream("openWrite", "/p1/g", {});
  await gate().stream("writeChunk", "/p1/g", w.id, new Uint8Array(10));
  auth.revoke(session);
  await assert.rejects(gate().stream("readChunk", "/p1/f", r.id, 1), code("EACCES"));
  await gate().stream("closeRead", "/p1/f", r.id);
  await gate().stream("abortWrite", "/p1/g", w.id);
  assert.equal(blocks(), n);
});

test("a missing or short block is an error, never zeros", async () => {
  const { gate, cap, s } = await setup();
  await capFiles(cap()).write("/p1/b", [pattern(2 * BLOCK_BYTES + 5)]);
  s.exec(
    "DELETE FROM fs_blocks WHERE idx = 1 AND content = (SELECT content FROM fs_entries WHERE path = '/p1/b')",
  );
  const { id } = await gate().stream("openRead", "/p1/b", { start: BLOCK_BYTES });
  await assert.rejects(gate().stream("readChunk", "/p1/b", id, 10), code("EIO"));
});

test("capFiles: move and copy take the exact target; a directory reads as nothing", async () => {
  const { cap } = await setup();
  const files = capFiles(cap());
  await files.write("/proj/x.txt", [new TextEncoder().encode("x")]);
  await files.mkdir("/proj/d");
  assert.equal(await files.move("/proj/x.txt", "/proj/d"), true);
  assert.equal((await files.stats("/proj/d")).kind, "file", "replaced, not moved into");
  assert.equal(await files.exists("/proj/d/x.txt"), false);
  assert.equal(await files.copy("/proj/d", "/proj/e"), true);
  assert.equal((await collect(files.read("/proj/e"))).toString(), "x");
  assert.equal((await collect(files.read("/proj/x"))).length, 0, "a directory reads as nothing");
});
