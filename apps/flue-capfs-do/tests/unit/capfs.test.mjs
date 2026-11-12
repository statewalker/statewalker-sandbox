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
  // Test hooks: run after a call (the size check) or before a files-RPC call.
  const hooks = { afterCall: undefined, beforeRpc: undefined };
  const capOf = (t) => ({
    call: async (m, p, ...a) => {
      methods.push(m);
      try {
        return await over(new FsGate(store, auth, t).call(m, p, ...structuredClone(a)));
      } finally {
        await hooks.afterCall?.(m, p);
      }
    },
    readdir: (p) => over(new FsGate(store, auth, t).readdir(p)),
    move: (k, a, b, o) => over(new FsGate(store, auth, t).move(k, a, b, o)),
    rpc: async (m, a) => {
      methods.push(`rpc:${m}`);
      await hooks.beforeRpc?.(m, a);
      return over(hub.call(t, m, structuredClone(a)));
    },
  });
  const ro = Biscuit.fromBase64(token)
    .attenuate(attenuationBlock({ readOnly: true }))
    .toBase64();
  return { store, methods, hooks, fs: new CapFs(capOf(token)), roFs: new CapFs(capOf(ro)) };
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
  // A write larger than one call, and a read of it (under the holder's ceiling).
  const big = "x".repeat(MAX_WHOLE_FILE_BYTES + 10);
  await fs.writeFile("/p1/big.txt", big);
  await fs.appendFile("/p1/big.txt", "END");
  const back = await fs.readFile("/p1/big.txt");
  assert.equal(back.length, MAX_WHOLE_FILE_BYTES + 13);
  assert.equal(back.slice(-6), "xxxEND");
  // An append larger than one call.
  await fs.writeFile("/p1/log.txt", "a");
  await fs.appendFile("/p1/log.txt", "y".repeat(MAX_WHOLE_FILE_BYTES + 1));
  assert.equal((await store.stat("/p1/log.txt")).size, MAX_WHOLE_FILE_BYTES + 2);
  assert.equal((await fs.readFileBuffer("/p1/log.txt"))[0], 0x61);
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

test("a large file removed or made a directory between the size check and the stream: ENOENT/EISDIR, not empty", async () => {
  const { fs, store, hooks } = await setup();
  const big = new Uint8Array(MAX_WHOLE_FILE_BYTES + 5).fill(120);
  for (const [name, change, err] of [
    ["gone", (p) => store.rm(p), "ENOENT"],
    [
      "dir",
      async (p) => {
        await store.rm(p);
        await store.mkdir(p);
      },
      "EISDIR",
    ],
  ]) {
    const path = `/p1/${name}.bin`;
    await fs.writeFile(path, big);
    let once = true;
    hooks.afterCall = async (m, p) => {
      if (m === "readFileBuffer" && p === path && once) {
        once = false;
        await change(p);
      }
    };
    await assert.rejects(fs.readFileBuffer(path), code(err), name);
    hooks.afterCall = undefined;
  }
});

test("a read larger than the holder's ceiling is EFBIG, before anything is streamed", async () => {
  const { fs, store, methods } = await setup();
  const { MAX_HOLDER_READ_BYTES } = await import("../../src/cap-bytes.ts");
  assert.ok(MAX_HOLDER_READ_BYTES >= 2 * MAX_WHOLE_FILE_BYTES);
  assert.ok(MAX_HOLDER_READ_BYTES < 64 * 1024 * 1024, "well under an isolate's 128 MB");
  await fs.writeFile("/p1/huge.bin", new Uint8Array(MAX_HOLDER_READ_BYTES + 1));
  methods.length = 0;
  await assert.rejects(fs.readFile("/p1/huge.bin"), code("EFBIG"));
  await assert.rejects(fs.readFileBuffer("/p1/huge.bin"), code("EFBIG"));
  assert.ok(!methods.includes("rpc:openRead"), "nothing streamed");
  assert.equal((await store.stat("/p1/huge.bin")).size, MAX_HOLDER_READ_BYTES + 1);
});

test("a large append that races another writer (ESTALE) is sent again", async () => {
  const { fs, store, hooks } = await setup();
  await fs.writeFile("/p1/log", "a");
  let once = true;
  hooks.beforeRpc = async (m) => {
    if (m === "closeWrite" && once) {
      once = false;
      await store.appendFile("/p1/log", "+");
    }
  };
  const more = "b".repeat(MAX_WHOLE_FILE_BYTES + 1);
  await fs.appendFile("/p1/log", more);
  assert.equal(
    (await store.stat("/p1/log")).size,
    2 + more.length,
    "appended once, after the race",
  );
});
