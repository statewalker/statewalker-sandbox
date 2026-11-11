// Strings and bytes in file encodings (src/bytes.ts), checked against Node's Buffer; CapFs
// sends exactly a view's bytes.
import assert from "node:assert/strict";
import { test } from "node:test";
import { bytesToString, stringToBytes } from "../../src/bytes.ts";
import { CapFs } from "../../src/capfs.ts";

const node = (s, e) => [...Buffer.from(s, e)];

test("strings in an encoding decode to the bytes Node's Buffer gives", () => {
  const cases = [
    ["héllo ÿ", "utf8"],
    ["ÿþ\u0000\u0001", "latin1"],
    ["ÿþ\u0000\u0001", "binary"],
    ["ÿA", "ascii"],
    ["00ff7f10", "hex"],
    ["00fF7", "hex"],
    ["1g", "hex"],
    ["+1", "hex"],
    ["//4AAQ==", "base64"],
    ["//4AAQ", "base64"],
    ["ab-_", "base64"],
    ["ab-_", "base64url"],
    ["YQ =\n=", "base64"],
    ["abcde", "base64"],
    ["", "base64"],
  ];
  for (const [s, e] of cases)
    assert.deepEqual([...stringToBytes(s, e)], node(s, e), `${e} ${JSON.stringify(s)}`);
});

test("bytes encode to the strings Node's Buffer gives", () => {
  const all = Uint8Array.from({ length: 256 }, (_, i) => i);
  for (const e of ["latin1", "binary", "ascii", "hex", "base64", "base64url", "utf8"])
    assert.equal(bytesToString(all, e), Buffer.from(all).toString(e), e);
  assert.throws(() => stringToBytes("x", "utf16le"), /EINVAL/);
});

test("CapFs sends exactly a view's bytes, not its whole buffer", async () => {
  const sent = [];
  const fs = new CapFs({ call: async (m, p, b) => sent.push([m, p, b]) });
  const heap = new Uint8Array(1 << 20);
  heap.set([1, 2, 3], 100);
  await fs.writeFile("/a", heap.subarray(100, 103));
  await fs.writeFile("/b", "ÿþ", "binary");
  await fs.writeFile("/c", "text");
  assert.deepEqual(
    sent.map(([m, p, b]) => [m, p, typeof b === "string" ? b : [b.buffer.byteLength, ...b]]),
    [
      ["writeFileBuffer", "/a", [3, 1, 2, 3]],
      ["writeFileBuffer", "/b", [2, 255, 254]],
      ["writeFile", "/c", "text"],
    ],
  );
});
