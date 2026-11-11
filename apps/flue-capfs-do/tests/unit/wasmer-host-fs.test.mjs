// The Wasmer host-filesystem protocol answered with a capability (src/wasmer/host-fs.ts), over
// an in-memory capability whose /ro subtree is read-only.
import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveGuestPath } from "../../src/wasmer/flue-sandbox.ts";
import { capHostFs } from "../../src/wasmer/host-fs.ts";

const E = (code, m) => Object.assign(new Error(`${code}: ${m}`), { code });
function fakeCap(entries = {}) {
  const files = new Map([["/", null], ["/ro", null], ...Object.entries(entries)]);
  const calls = [];
  // Read streams as the store keeps them: a snapshot of the bytes, a position, an owner-free id.
  const streams = new Map();
  let streamLimit = Number.POSITIVE_INFINITY;
  const bytesOf = (v) => (typeof v === "string" ? Buffer.from(v, "utf8") : Buffer.from(v));
  const kids = (p) => {
    const pre = p === "/" ? "/" : `${p}/`;
    return [...files.keys()].filter((k) => k !== p && k.startsWith(pre));
  };
  return {
    files,
    calls,
    streams,
    limitStreams: (n) => {
      streamLimit = n;
    },
    async call(method, path, ...args) {
      calls.push(`${method} ${path}`);
      if (
        ["writeFile", "writeFileBuffer", "appendFile", "mkdir", "rm"].includes(method) &&
        path.startsWith("/ro")
      )
        throw E("EACCES", `permission denied, write '${path}'`);
      switch (method) {
        case "exists":
          return files.has(path);
        case "stat": {
          if (!files.has(path)) throw E("ENOENT", path);
          const v = files.get(path);
          return {
            isDirectory: v === null,
            size: v === null ? 0 : Buffer.byteLength(v),
            mtime: "2026-01-01T00:00:00Z",
          };
        }
        case "readdirStat": {
          const pre = path === "/" ? "/" : `${path}/`;
          return kids(path)
            .filter((k) => !k.slice(pre.length).includes("/"))
            .map((k) => {
              const v = files.get(k);
              return {
                name: k.slice(pre.length),
                isDirectory: v === null,
                size: v === null ? 0 : Buffer.byteLength(v),
                mtime: "2026-01-01T00:00:00Z",
              };
            });
        }
        case "readFile":
          if (!files.has(path)) throw E("ENOENT", path);
          return files.get(path);
        case "openRead": {
          if (!files.has(path)) throw E("ENOENT", path);
          if (streams.size >= streamLimit) throw E("EMFILE", "too many open streams");
          const b = bytesOf(files.get(path));
          const id = `s${streams.size + 1}-${Math.random()}`;
          const start = Math.min(Number(args[0]?.start ?? 0), b.length);
          streams.set(id, { path, b, pos: start });
          return { id, size: b.length };
        }
        case "readChunk": {
          const st = streams.get(args[0]);
          if (!st || st.path !== path) throw E("EBADF", String(args[0]));
          const n = Math.min(Number(args[1] ?? 1 << 20), 1 << 20);
          const out = new Uint8Array(st.b.subarray(st.pos, st.pos + n));
          st.pos += out.length;
          return out;
        }
        case "closeRead":
          streams.delete(args[0]);
          return;
        // The store keeps bytes: here UTF-8 content is kept as a string (easy to assert on),
        // anything else as a Buffer.
        case "readFileBuffer": {
          if (!files.has(path)) throw E("ENOENT", path);
          const v = files.get(path);
          return new Uint8Array(typeof v === "string" ? Buffer.from(v, "utf8") : v);
        }
        case "writeFileBuffer": {
          const b = Buffer.from(args[0]);
          let text;
          try {
            text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(b);
          } catch {}
          files.set(path, text ?? b);
          return;
        }
        case "writeFile":
          files.set(path, args[0]);
          return;
        case "appendFile":
          files.set(path, (files.get(path) ?? "") + args[0]);
          return;
        case "mkdir":
          files.set(path, null);
          return;
        case "rm":
          if (files.get(path) === null && !args[0]?.recursive) throw E("EISDIR", path);
          for (const k of kids(path)) files.delete(k);
          files.delete(path);
          return;
      }
      throw E("ENOSYS", method);
    },
    async readdir(path) {
      const pre = path === "/" ? "/" : `${path}/`;
      return kids(path)
        .filter((k) => !k.slice(pre.length).includes("/"))
        .map((k) => k.slice(pre.length));
    },
    async move(_kind, s, d) {
      for (const k of [...files.keys()])
        if (k === s || k.startsWith(`${s}/`)) {
          files.set(d + k.slice(s.length), files.get(k));
          files.delete(k);
        }
    },
  };
}
const enc = (s) => new TextEncoder().encode(s);
const dec = (b) => new TextDecoder().decode(b);
// open(path, read, write, create, createNew, truncate, append)
const RW = [true, true, false, false, false, false];
const CREATE = [false, true, true, false, true, false];
const APPEND = [false, true, true, false, false, true];

test("write, close, read back; writes are saved at close", async () => {
  const cap = fakeCap();
  const fs = capHostFs(cap);
  const { value: id } = await fs.handle("open", ["a.txt", ...CREATE]);
  assert.deepEqual(await fs.handle("write", [id, 0, enc("hello ")]), { value: 6 });
  assert.deepEqual(await fs.handle("write", [id, 6, enc("world")]), { value: 5 });
  assert.equal(cap.files.get("/a.txt"), "");
  await fs.handle("close", [id]);
  assert.equal(cap.files.get("/a.txt"), "hello world");
  const { value: r } = await fs.handle("open", ["a.txt", ...RW]);
  assert.equal(dec((await fs.handle("read", [r, 6, 100])).value), "world");
  assert.equal((await fs.handle("fileStat", [r])).value.size, 11);
});

test("opening to read does not ask for the write right; writing a read-only file fails at the write", async () => {
  const cap = fakeCap({ "/ro/f.txt": "orig" });
  const fs = capHostFs(cap);
  const { value: id } = await fs.handle("open", ["ro/f.txt", ...RW]);
  assert.equal(dec((await fs.handle("read", [id, 0, 10])).value), "orig");
  assert.ok(!cap.calls.some((c) => c.startsWith("appendFile")));
  const w = await fs.handle("write", [id, 4, enc("!")]);
  assert.equal(w.error.code, "EACCES");
  await fs.handle("close", [id]);
  assert.equal(cap.files.get("/ro/f.txt"), "orig");
  // Creating or truncating fails at open.
  assert.equal((await fs.handle("open", ["ro/new.txt", ...CREATE])).error.code, "EACCES");
});

test("append mode writes at the end", async () => {
  const cap = fakeCap({ "/log": "a\n" });
  const fs = capHostFs(cap);
  const { value: id } = await fs.handle("open", ["log", ...APPEND]);
  await fs.handle("write", [id, 0, enc("b\n")]);
  await fs.handle("close", [id]);
  assert.equal(cap.files.get("/log"), "a\nb\n");
});

test("binary content is stored byte for byte; a character split across writes is too", async () => {
  const cap = fakeCap();
  const fs = capHostFs(cap);
  const { value: bin } = await fs.handle("open", ["bin", ...CREATE]);
  const all = Uint8Array.from({ length: 256 }, (_, i) => i);
  assert.deepEqual(await fs.handle("write", [bin, 0, all]), { value: 256 });
  await fs.handle("close", [bin]);
  assert.deepEqual([...cap.files.get("/bin")], [...all]);
  const { value: r } = await fs.handle("open", ["bin", ...RW]);
  assert.deepEqual(
    [...(await fs.handle("read", [r, 250, 10])).value],
    [250, 251, 252, 253, 254, 255],
  );
  await fs.handle("close", [r]);
  const { value: id } = await fs.handle("open", ["b", ...CREATE]);
  const e = enc("é"); // two bytes
  assert.deepEqual(await fs.handle("write", [id, 0, e.subarray(0, 1)]), { value: 1 });
  assert.deepEqual(await fs.handle("write", [id, 1, e.subarray(1)]), { value: 1 });
  await fs.handle("close", [id]);
  assert.equal(cap.files.get("/b"), "é");
});

test("a byte-order mark survives a rewrite", async () => {
  const cap = fakeCap({ "/bom": "﻿x" });
  const fs = capHostFs(cap);
  const { value: id } = await fs.handle("open", ["bom", ...RW]);
  await fs.handle("write", [id, 4, enc("y")]);
  await fs.handle("close", [id]);
  assert.equal(cap.files.get("/bom"), "﻿xy");
});

test("two handles on one file share its bytes", async () => {
  const cap = fakeCap({ "/s": "" });
  const fs = capHostFs(cap);
  const { value: a } = await fs.handle("open", ["s", ...RW]);
  const { value: b } = await fs.handle("open", ["s", ...RW]);
  await fs.handle("write", [a, 0, enc("one")]);
  assert.equal(dec((await fs.handle("read", [b, 0, 10])).value), "one");
  await fs.handle("close", [a]);
  await fs.handle("close", [b]);
  assert.equal(cap.files.get("/s"), "one");
});

test("many small writes and setLen", async () => {
  const cap = fakeCap();
  const fs = capHostFs(cap);
  const { value: id } = await fs.handle("open", ["big", ...CREATE]);
  for (let i = 0; i < 2000; i++) await fs.handle("write", [id, i * 2, enc("ab")]);
  await fs.handle("setLen", [id, 3]);
  await fs.handle("close", [id]);
  assert.equal(cap.files.get("/big"), "aba");
});

test("directories: an empty one is removed, a full one is not; rename", async () => {
  const cap = fakeCap({ "/d": null, "/full": null, "/full/x": "1", "/m": "m" });
  const fs = capHostFs(cap);
  assert.deepEqual(await fs.handle("remove", ["d"]), { value: null });
  assert.ok(!cap.files.has("/d"));
  assert.equal((await fs.handle("remove", ["full"])).error.code, "ENOTEMPTY");
  assert.deepEqual(await fs.handle("rename", ["m", "full/m"]), { value: null });
  assert.equal(cap.files.get("/full/m"), "m");
  const list = (await fs.handle("readDir", ["full"])).value.map((e) => [e.name, e.kind]);
  assert.deepEqual(list.sort(), [
    ["m", "file"],
    ["x", "file"],
  ]);
});

test("'..', unknown operations and closed handles are refused", async () => {
  const fs = capHostFs(fakeCap());
  assert.equal((await fs.handle("stat", ["a/../../etc"])).error.code, "EACCES");
  assert.equal((await fs.handle("chmod", ["x"])).error.code, "ENOTSUP");
  assert.equal((await fs.handle("read", [42, 0, 1])).error.code, "EBADF");
  assert.equal((await fs.handle("__proto__", [])).error.code, "ENOTSUP");
});

test("Flue's guest paths resolve '..' before they reach the capability", () => {
  assert.equal(resolveGuestPath("/workspace/../etc/passwd"), "/etc/passwd");
  assert.equal(resolveGuestPath("a/./b/../c"), "/workspace/a/c");
  assert.equal(resolveGuestPath("/workspace"), "/workspace");
});

test("any length is kept, even one inside a character (the store keeps bytes)", async () => {
  const cap = fakeCap({ "/e": "éX" });
  const fs = capHostFs(cap);
  const { value: id } = await fs.handle("open", ["e", ...RW]);
  assert.deepEqual(await fs.handle("setLen", [id, 1]), { value: null });
  await fs.handle("close", [id]);
  assert.deepEqual([...cap.files.get("/e")], [0xc3]);
});

test("readDir is one capability call with sizes and times; NUL bytes and gaps are kept", async () => {
  const cap = fakeCap({ "/d": null, "/d/e.txt": "é", "/d/sub": null });
  const fs = capHostFs(cap);
  const calls = cap.calls.length;
  const { value } = await fs.handle("readDir", ["d"]);
  assert.deepEqual(cap.calls.slice(calls), ["readdirStat /d"]);
  const e = value.find((x) => x.name === "e.txt");
  assert.equal(e.size, 2);
  assert.equal(e.modified, String(BigInt(Date.parse("2026-01-01T00:00:00Z")) * 1_000_000n));
  assert.equal(value.find((x) => x.name === "sub").kind, "directory");

  const { value: id } = await fs.handle("open", ["n", ...CREATE]);
  assert.deepEqual(await fs.handle("write", [id, 0, enc("a\0b")]), { value: 3 });
  assert.deepEqual(await fs.handle("write", [id, 5, enc("c")]), { value: 1 }, "a gap is NUL");
  assert.deepEqual(await fs.handle("setLen", [id, 8]), { value: null });
  await fs.handle("close", [id]);
  assert.equal(cap.files.get("/n"), "a\0b\0\0c\0\0");
});

test("metadata cache: listings answer stats, misses are remembered, this run's writes are seen", async () => {
  const cap = fakeCap({ "/d": null, "/d/a": "1", "/d/b": "22", "/ro/x": "x" });
  const fs = capHostFs(cap);
  const count = (from, method) =>
    cap.calls.slice(from).filter((c) => c.startsWith(`${method} `)).length;

  let at = cap.calls.length;
  await fs.handle("readDir", ["d"]);
  await fs.handle("readDir", ["d"]);
  for (const n of ["a", "b"])
    assert.equal((await fs.handle("stat", [`d/${n}`])).value.kind, "file");
  assert.equal(count(at, "readdirStat"), 1, "the listing is reused");
  assert.equal(count(at, "stat"), 0, "a listing answers its entries' stats");

  at = cap.calls.length;
  for (let i = 0; i < 3; i++)
    assert.equal((await fs.handle("stat", ["d/nope"])).error.code, "ENOENT");
  assert.equal(count(at, "stat"), 1, "no such file is remembered");

  // This run creates it: the next lookup sees it, and the listing shows it.
  const { value: id } = await fs.handle("open", ["d/nope", ...CREATE]);
  await fs.handle("write", [id, 0, enc("abc")]);
  await fs.handle("close", [id]);
  assert.equal((await fs.handle("stat", ["d/nope"])).value.size, 3);
  assert.ok((await fs.handle("readDir", ["d"])).value.some((e) => e.name === "nope"));

  // Renames and removals forget the whole tree.
  await fs.handle("mkdir", ["d/t"]);
  const { value: t } = await fs.handle("open", ["d/t/f", ...CREATE]);
  await fs.handle("close", [t]);
  assert.equal((await fs.handle("stat", ["d/t/f"])).value.kind, "file");
  await fs.handle("rename", ["d/t", "d/u"]);
  assert.equal((await fs.handle("stat", ["d/t/f"])).error.code, "ENOENT");
  assert.equal((await fs.handle("stat", ["d/u/f"])).value.kind, "file");
  await fs.handle("remove", ["d/u/f"]);
  assert.equal((await fs.handle("stat", ["d/u/f"])).error.code, "ENOENT");

  // Refusals are not cached.
  cap.files.set("/secret", "s");
  const denyStat = cap.call;
  let refuse = true;
  cap.call = async (m, p, ...a) => {
    if (refuse && m === "stat" && p === "/secret")
      throw Object.assign(new Error("EACCES: no"), { code: "EACCES" });
    return denyStat.call(cap, m, p, ...a);
  };
  assert.equal((await fs.handle("stat", ["secret"])).error.code, "EACCES");
  refuse = false;
  assert.equal((await fs.handle("stat", ["secret"])).value.kind, "file");
});

test("metadata cache: cleared before each command, and kept only briefly within one", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  const cap = fakeCap({ "/a": "1" });
  const fs = capHostFs(cap);
  const stats = () => cap.calls.filter((c) => c === "stat /a").length;
  await fs.handle("stat", ["a"]);
  await fs.handle("stat", ["a"]);
  assert.equal(stats(), 1);
  // Another writer changes the file: the next command sees it.
  cap.files.set("/a", "1234");
  fs.resetCache();
  assert.equal((await fs.handle("stat", ["a"])).value.size, 4);
  assert.equal(stats(), 2);
  // Within a command, an entry expires.
  cap.files.set("/a", "12");
  t.mock.timers.tick(1000);
  assert.equal((await fs.handle("stat", ["a"])).value.size, 4, "still cached");
  t.mock.timers.tick(1500);
  assert.equal((await fs.handle("stat", ["a"])).value.size, 2, "expired");
});

test("metadata cache: a parallel writer's file is not truncated, a late answer is not cached", async () => {
  const cap = fakeCap();
  const fs = capHostFs(cap);
  // The guest looked for `log` (no such file, cached); a Flue tool call then wrote it.
  assert.equal((await fs.handle("stat", ["log"])).error.code, "ENOENT");
  cap.files.set("/log", "from a tool\n");
  const { value: id } = await fs.handle("open", ["log", ...APPEND]);
  await fs.handle("write", [id, 0, enc("guest\n")]);
  await fs.handle("close", [id]);
  assert.equal(cap.files.get("/log"), "from a tool\nguest\n");

  // A stat the kernel gave up on answers after the run created the file: not cached.
  let release;
  const slow = new Promise((r) => (release = r));
  const call = cap.call;
  cap.call = async (m, p, ...a) => {
    if (m === "stat" && p === "/x" && release) {
      const r = call.call(cap, m, p, ...a).catch((e) => e);
      await slow;
      const v = await r;
      if (v instanceof Error) throw v;
      return v;
    }
    return call.call(cap, m, p, ...a);
  };
  const late = fs.handle("stat", ["x"]);
  const r = release;
  release = undefined;
  const { value: x } = await fs.handle("open", ["x", ...CREATE]);
  await fs.handle("close", [x]);
  r();
  assert.equal((await late).error.code, "ENOENT");
  assert.equal((await fs.handle("stat", ["x"])).value.kind, "file");
});

test("reads of a file not written stream in chunks: any size, one chunk in memory", async () => {
  const big = Buffer.alloc(5 * 1024 * 1024 + 7);
  for (let i = 0; i < big.length; i++) big[i] = (i * 31) & 0xff;
  const cap = fakeCap({ "/big": big });
  const fs = capHostFs(cap);
  const { value: id } = await fs.handle("open", ["big", ...RW]);
  // Sequential reads of 64 KiB, as cat does: one readChunk per MiB.
  const parts = [];
  for (let at = 0; ; at += 65536) {
    const r = (await fs.handle("read", [id, at, 65536])).value;
    if (!r.length) break;
    parts.push(Buffer.from(r));
  }
  assert.ok(Buffer.concat(parts).equals(big));
  assert.equal(cap.calls.filter((c) => c.startsWith("readChunk")).length, 6);
  assert.equal(
    cap.calls.filter((c) => c.startsWith("readFileBuffer")).length,
    0,
    "never read whole",
  );
  // A read elsewhere reopens the stream there.
  const r = (await fs.handle("read", [id, 3_000_000, 10])).value;
  assert.ok(Buffer.from(r).equals(big.subarray(3_000_000, 3_000_010)));
  assert.equal(cap.calls.filter((c) => c.startsWith("openRead")).length, 2);
  await fs.handle("close", [id]);
  assert.equal(cap.streams.size, 0, "closed with the file");
});

test("a written file reads its bytes; no room for a stream falls back to a whole read", async () => {
  const cap = fakeCap({ "/a": "hello", "/b": "world" });
  const fs = capHostFs(cap);
  const { value: id } = await fs.handle("open", ["a", ...RW]);
  assert.equal(dec((await fs.handle("read", [id, 0, 3])).value), "hel");
  await fs.handle("write", [id, 5, enc("!")]);
  assert.equal(cap.streams.size, 0, "the stream is closed once the file is loaded");
  assert.equal(dec((await fs.handle("read", [id, 0, 10])).value), "hello!");
  await fs.handle("close", [id]);
  cap.limitStreams(0);
  const { value: b } = await fs.handle("open", ["b", ...RW]);
  assert.equal(dec((await fs.handle("read", [b, 1, 3])).value), "orl");
  assert.ok(cap.calls.includes("readFileBuffer /b"));
});

test("streamed reads recover: an expired stream reopens, a rename closes it, handles read apart", async () => {
  const big = Buffer.alloc(3 * 1024 * 1024);
  for (let i = 0; i < big.length; i++) big[i] = (i * 7) & 0xff;
  const cap = fakeCap({ "/f": big });
  const fs = capHostFs(cap);
  const opens = () => cap.calls.filter((c) => c.startsWith("openRead")).length;
  const read = async (id, at, n) => Buffer.from((await fs.handle("read", [id, at, n])).value);

  // The store dropped the stream (idle, or the cell restarted): the next read reopens there.
  const { value: a } = await fs.handle("open", ["f", ...RW]);
  assert.ok((await read(a, 0, 1 << 20)).equals(big.subarray(0, 1 << 20)));
  cap.streams.clear();
  assert.ok((await read(a, 1 << 20, 100)).equals(big.subarray(1 << 20, (1 << 20) + 100)));

  // A rename closes the stream (it names the old path); reads go on under the new name.
  await fs.handle("rename", ["f", "g"]);
  assert.equal(cap.streams.size, 0);
  assert.ok((await read(a, 2 << 20, 10)).equals(big.subarray(2 << 20, (2 << 20) + 10)));

  // Two handles reading at places far apart do not reopen each other's streams.
  const { value: b } = await fs.handle("open", ["g", ...RW]);
  const before = opens();
  for (let i = 0; i < 8; i++) {
    await read(a, (2 << 20) + 10 + i * 1000, 1000);
    await read(b, i * 1000, 1000);
  }
  assert.equal(opens() - before, 1, "only b's first read opens a stream");
  // fstat reports the size the handle reads.
  assert.equal((await fs.handle("fileStat", [b])).value.size, big.length);
  // Truncating through another open closes the readers.
  const { value: t } = await fs.handle("open", ["g", false, true, false, false, true, false]);
  assert.equal(cap.streams.size, 0);
  assert.equal((await read(b, 0, 10)).length, 0);
  for (const id of [a, b, t]) await fs.handle("close", [id]);
});

test("streamed reads: a full stream table frees the least recently used reader; closing mid-open leaks nothing", async () => {
  const cap = fakeCap({ "/x": "x".repeat(100), "/y": "y".repeat(100), "/z": "z".repeat(100) });
  const fs = capHostFs(cap);
  cap.limitStreams(2);
  const ids = [];
  for (const n of ["x", "y", "z"]) {
    const { value } = await fs.handle("open", [n, ...RW]);
    ids.push(value);
    assert.equal(dec((await fs.handle("read", [value, 0, 3])).value), n.repeat(3));
  }
  assert.equal(cap.streams.size, 2, "x's reader made room for z's");
  assert.ok(!cap.calls.includes("readFileBuffer /z"), "z still streams");
  for (const id of ids) await fs.handle("close", [id]);
  assert.equal(cap.streams.size, 0);
  // The handle closes while its stream is opening: the new stream is given back.
  cap.limitStreams(Number.POSITIVE_INFINITY);
  const { value: id } = await fs.handle("open", ["x", ...RW]);
  const pending = fs.handle("read", [id, 0, 1]);
  await fs.handle("close", [id]);
  await pending;
  assert.equal(cap.streams.size, 0);
});
