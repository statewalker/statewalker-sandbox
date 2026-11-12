// CapFs (src/capfs.ts), the just-bash file system over a capability, on the real Authority,
// FsGate, SqlFs and files-RPC hub: bytes are all that crosses the capability (text is encoded
// and decoded here), and files larger than a whole-file call move as files-RPC streams.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Biscuit } from "@statewalker/webrun-biscuit";
import { Authority, FsGate } from "../../src/authority.ts";
import { CapFs } from "../../src/capfs.ts";
import { FilesRpcHub } from "../../src/files-rpc-hub.ts";
import { rebuildError } from "../../src/path.ts";
import { attenuationBlock } from "../../src/policy.ts";
import { MAX_WHOLE_FILE_BYTES, SqlFs } from "../../src/sql-fs.ts";
import { sql } from "../helpers/sql.mjs";

async function setup() {
  const db = sql();
  const store = new SqlFs(db);
  const auth = new Authority(db);
  const hub = new FilesRpcHub(store, auth);
  const { token } = auth.startSession("alice", ["/p1"]);
  const methods = [];
  // A capability as holders get it: arguments and results cloned, errors rebuilt.
  const over = (p) =>
    p.then(structuredClone, (e) => {
      throw rebuildError(structuredClone(e));
    });
  const capOf = (t) => ({
    call: (m, p, ...a) => (
      methods.push(m), over(new FsGate(store, auth, t).call(m, p, ...structuredClone(a)))
    ),
    readdir: (p) => over(new FsGate(store, auth, t).readdir(p)),
    move: (k, a, b, o) => over(new FsGate(store, auth, t).move(k, a, b, o)),
    rpc: (m, a) => (methods.push(`rpc:${m}`), over(hub.call(t, m, structuredClone(a)))),
  });
  const ro = Biscuit.fromBase64(token)
    .attenuate(attenuationBlock({ readOnly: true }))
    .toBase64();
  return { store, methods, fs: new CapFs(capOf(token)), roFs: new CapFs(capOf(ro)) };
}
const code = (c) => (e) => e.code === c || String(e.message).startsWith(`${c}:`);
const TEXT_METHODS = ["readFile", "writeFile", "appendFile"];

test("text and bytes cross the capability as bytes only", async () => {
  const { fs, store, methods } = await setup();
  await fs.writeFile("/p1/t.txt", "héllo ÿ\n");
  await fs.appendFile("/p1/t.txt", "more\n");
  assert.equal(await fs.readFile("/p1/t.txt"), "héllo ÿ\nmore\n");
  assert.equal(await fs.readFile("/p1/t.txt", "utf8"), "héllo ÿ\nmore\n");
  assert.equal(await fs.readFile("/p1/t.txt", { encoding: "utf-8" }), "héllo ÿ\nmore\n");
  assert.equal(await store.readFile("/p1/t.txt"), "héllo ÿ\nmore\n", "stored as its UTF-8 bytes");
  // Other encodings, and a leading U+FEFF kept as text (as the store keeps it).
  await fs.writeFile("/p1/b.bin", "ÿþ\u0000\u0001", "latin1");
  assert.deepEqual([...(await fs.readFileBuffer("/p1/b.bin"))], [255, 254, 0, 1]);
  assert.equal(await fs.readFile("/p1/b.bin", "hex"), "fffe0001");
  await fs.writeFile("/p1/bom.txt", "﻿x");
  assert.equal(await fs.readFile("/p1/bom.txt"), "﻿x");
  // Invalid UTF-8 reads as the store reads it: U+FFFD for each bad sequence.
  await fs.writeFile("/p1/bad.txt", new Uint8Array([0x61, 0xff, 0x62]));
  assert.equal(await fs.readFile("/p1/bad.txt"), await store.readFile("/p1/bad.txt"));
  assert.deepEqual(
    methods.filter((m) => TEXT_METHODS.includes(m)),
    [],
    `no string call crossed: ${methods.join(", ")}`,
  );
});

test("files larger than a whole-file call are written, appended and read as streams", async () => {
  const { fs, store, methods } = await setup();
  const big = "x".repeat(MAX_WHOLE_FILE_BYTES + 10);
  await fs.writeFile("/p1/big.txt", big);
  await fs.appendFile("/p1/big.txt", "END");
  await fs.appendFile("/p1/big.txt", "y".repeat(MAX_WHOLE_FILE_BYTES + 1));
  assert.equal((await store.stat("/p1/big.txt")).size, 2 * MAX_WHOLE_FILE_BYTES + 14);
  const back = await fs.readFile("/p1/big.txt");
  assert.equal(back.length, 2 * MAX_WHOLE_FILE_BYTES + 14);
  assert.equal(back.slice(MAX_WHOLE_FILE_BYTES + 5, MAX_WHOLE_FILE_BYTES + 16), "xxxxxENDyyy");
  assert.equal((await fs.readFileBuffer("/p1/big.txt")).length, 2 * MAX_WHOLE_FILE_BYTES + 14);
  for (const m of ["rpc:openWrite", "rpc:openRead"]) assert.ok(methods.includes(m), m);
});

test("errors are the same as before: missing, directory, refused", async () => {
  const { fs, roFs } = await setup();
  await fs.writeFile("/p1/a.txt", "a");
  await fs.mkdir("/p1/d");
  await assert.rejects(fs.readFile("/p1/none"), code("ENOENT"));
  await assert.rejects(fs.readFileBuffer("/p1/none"), code("ENOENT"));
  await assert.rejects(fs.readFile("/p1/d"), code("EISDIR"));
  await assert.rejects(fs.writeFile("/p1/d", "x"), code("EISDIR"));
  await assert.rejects(fs.readFile("/p10/x"), code("EACCES"));
  await assert.rejects(roFs.writeFile("/p1/a.txt", "x"), code("EACCES"));
  await assert.rejects(roFs.appendFile("/p1/a.txt", "x"), code("EACCES"));
  await assert.rejects(
    roFs.writeFile("/p1/a.txt", "x".repeat(MAX_WHOLE_FILE_BYTES + 1)),
    code("EACCES"),
  );
  assert.equal(await roFs.readFile("/p1/a.txt"), "a");
  // /dev/null stays a sink, handled here.
  await fs.writeFile("/dev/null", "gone");
  assert.equal(await fs.readFile("/dev/null"), "");
});
