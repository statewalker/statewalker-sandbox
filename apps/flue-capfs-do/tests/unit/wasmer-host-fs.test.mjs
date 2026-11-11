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
  const kids = (p) => {
    const pre = p === "/" ? "/" : `${p}/`;
    return [...files.keys()].filter((k) => k !== p && k.startsWith(pre));
  };
  return {
    files,
    calls,
    async call(method, path, ...args) {
      calls.push(`${method} ${path}`);
      if (["writeFile", "appendFile", "mkdir", "rm"].includes(method) && path.startsWith("/ro"))
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

test("binary content is refused at the write; a character split across writes is not", async () => {
  const cap = fakeCap();
  const fs = capHostFs(cap);
  const { value: id } = await fs.handle("open", ["b", ...CREATE]);
  assert.equal(
    (await fs.handle("write", [id, 0, Uint8Array.of(0xff, 0xfe)])).error.code,
    "ENOTSUP",
  );
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

test("a length that cuts a character is refused", async () => {
  const cap = fakeCap({ "/e": "éX" });
  const fs = capHostFs(cap);
  const { value: id } = await fs.handle("open", ["e", ...RW]);
  assert.equal((await fs.handle("setLen", [id, 1])).error.code, "ENOTSUP");
  assert.deepEqual(await fs.handle("setLen", [id, 2]), { value: null });
  await fs.handle("close", [id]);
  assert.equal(cap.files.get("/e"), "é");
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
