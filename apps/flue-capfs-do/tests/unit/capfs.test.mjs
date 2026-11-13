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
  return {
    store,
    methods,
    hooks,
    cap: capOf(token),
    fs: new CapFs(capOf(token)),
    roFs: new CapFs(capOf(ro)),
  };
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

// ---- a tool's whole-file calls, answered on the host side (largeFileCalls) ----

test("a tool's whole-file calls over 16 MiB are streamed on the host side", async () => {
  const { cap, store, methods } = await setup();
  const { largeFileCalls } = await import("../../src/cap-bytes.ts");
  const call = largeFileCalls(cap);
  const big = new Uint8Array(MAX_WHOLE_FILE_BYTES + 3).map((_, i) => (i * 7) & 255);
  await call("writeFileBuffer", "/p1/big.bin", big);
  await call("appendFileBuffer", "/p1/big.bin", big.subarray(0, 5));
  await call("appendFileBuffer", "/p1/app.bin", big.subarray(0, MAX_WHOLE_FILE_BYTES + 1));
  const back = await call("readFileBuffer", "/p1/big.bin");
  assert.equal(back.length, MAX_WHOLE_FILE_BYTES + 8);
  assert.deepEqual(back.subarray(0, MAX_WHOLE_FILE_BYTES + 3), big);
  assert.deepEqual(back.subarray(MAX_WHOLE_FILE_BYTES + 3), big.subarray(0, 5));
  assert.equal((await store.stat("/p1/app.bin")).size, MAX_WHOLE_FILE_BYTES + 1);
  assert.ok(methods.includes("rpc:openWrite") && methods.includes("rpc:openRead"), "streamed");
  // Small files and every other call go as they are.
  methods.length = 0;
  await call("writeFileBuffer", "/p1/s.bin", new Uint8Array([1, 2]));
  assert.deepEqual([...(await call("readFileBuffer", "/p1/s.bin"))], [1, 2]);
  assert.equal((await call("stat", "/p1/s.bin")).size, 2);
  assert.ok(!methods.some((m) => m.startsWith("rpc:")), methods.join(", "));
  await assert.rejects(call("readFileBuffer", "/p1/none"), code("ENOENT"));
  await assert.rejects(call("writeFileBuffer", "/p2/x", new Uint8Array(1)), code("EACCES"));
  assert.equal((await store.stat("/p1/big.bin")).size, MAX_WHOLE_FILE_BYTES + 8);
});

test("a tool's read must fit the RPC reply: EFBIG on the host, before anything is streamed", async () => {
  const { cap, fs, methods } = await setup();
  const { largeFileCalls, MAX_TOOL_READ_BYTES } = await import("../../src/cap-bytes.ts");
  assert.ok(MAX_TOOL_READ_BYTES > MAX_WHOLE_FILE_BYTES);
  assert.ok(MAX_TOOL_READ_BYTES <= 31 * 1024 * 1024, "room for the reply under JS RPC's 32 MiB");
  await fs.writeFile("/p1/r.bin", new Uint8Array(MAX_TOOL_READ_BYTES + 1));
  methods.length = 0;
  await assert.rejects(largeFileCalls(cap)("readFileBuffer", "/p1/r.bin"), code("EFBIG"));
  assert.ok(!methods.includes("rpc:openRead"), "nothing streamed");
});

test("a tool's large calls stream one at a time in an isolate (host memory)", async () => {
  const { cap, hooks } = await setup();
  const { largeFileCalls } = await import("../../src/cap-bytes.ts");
  let open = 0;
  let most = 0;
  hooks.beforeRpc = async (m) => {
    if (m === "openWrite" || m === "openRead") most = Math.max(most, ++open);
    if (m === "closeWrite" || m === "closeRead") open--;
  };
  const big = new Uint8Array(MAX_WHOLE_FILE_BYTES + 1);
  // Two capabilities' calls (two tools in one isolate) wait for each other.
  await Promise.all([
    largeFileCalls(cap)("writeFileBuffer", "/p1/a.bin", big),
    largeFileCalls(cap)("writeFileBuffer", "/p1/b.bin", big),
    largeFileCalls(cap)("appendFileBuffer", "/p1/c.bin", big),
  ]);
  await Promise.all([
    largeFileCalls(cap)("readFileBuffer", "/p1/a.bin"),
    largeFileCalls(cap)("readFileBuffer", "/p1/b.bin"),
  ]);
  assert.equal(most, 1);
});

test("everyCall checks before each call and files-RPC call (a tool's run still active)", async () => {
  const { cap, store } = await setup();
  const { everyCall, largeFileCalls } = await import("../../src/cap-bytes.ts");
  let active = true;
  let checks = 0;
  const live = everyCall(cap, async () => {
    checks++;
    if (!active) throw new Error("EACCES: the tool's run is over");
  });
  const big = new Uint8Array(MAX_WHOLE_FILE_BYTES + 1);
  await largeFileCalls(live)("writeFileBuffer", "/p1/l.bin", big);
  assert.ok(checks > 2, `checked on every call of the stream (${checks})`);
  // The run ends while a large read streams: its next call is refused.
  let calls = 0;
  const ending = everyCall(cap, async () => {
    if (++calls === 3) active = false;
    if (!active) throw new Error("EACCES: the tool's run is over");
  });
  await assert.rejects(largeFileCalls(ending)("readFileBuffer", "/p1/l.bin"), code("EACCES"));
  assert.equal((await store.stat("/p1/l.bin")).size, MAX_WHOLE_FILE_BYTES + 1);
});

test("an older bundle's text calls over 16 MiB are streamed too (UTF-8, as the store's)", async () => {
  const { cap, store, methods } = await setup();
  const { largeFileCalls } = await import("../../src/cap-bytes.ts");
  const call = largeFileCalls(cap);
  const big = `é${"a".repeat(MAX_WHOLE_FILE_BYTES)}`;
  await call("writeFile", "/p1/t.txt", big);
  await call("appendFile", "/p1/t.txt", "ÿ\n");
  assert.equal((await store.stat("/p1/t.txt")).size, MAX_WHOLE_FILE_BYTES + 2 + 3);
  const back = await call("readFile", "/p1/t.txt");
  assert.equal(back.length, big.length + 2);
  assert.ok(back.startsWith("éaaa") && back.endsWith("aaÿ\n"));
  assert.ok(methods.includes("rpc:openWrite") && methods.includes("rpc:openRead"), "streamed");
  // Small text reads as the store reads it (U+FFFD for invalid UTF-8, a leading U+FEFF kept).
  await store.writeFileBuffer("/p1/s.txt", new Uint8Array([0xef, 0xbb, 0xbf, 0x61, 0xff]));
  assert.equal(await call("readFile", "/p1/s.txt"), await store.readFile("/p1/s.txt"));
  await assert.rejects(call("readFile", "/p1/none"), code("ENOENT"));
  await assert.rejects(call("writeFile", "/p2/x", "x"), code("EACCES"));
});

test("a text read whose reply would not fit JS RPC is EFBIG (two-byte strings)", async () => {
  const { cap, fs } = await setup();
  const { largeFileCalls } = await import("../../src/cap-bytes.ts");
  // 20 MiB of ASCII and one character outside Latin-1: a two-byte string of about 40 MiB.
  await fs.writeFile("/p1/w.txt", `Ā${"a".repeat(20 * 1024 * 1024)}`);
  await assert.rejects(largeFileCalls(cap)("readFile", "/p1/w.txt"), code("EFBIG"));
  // The same size in Latin-1 text fits (one byte a character).
  await fs.writeFile("/p1/l.txt", `ÿ${"a".repeat(20 * 1024 * 1024)}`);
  assert.equal((await largeFileCalls(cap)("readFile", "/p1/l.txt")).length, 20 * 1024 * 1024 + 1);
});
