/**
 * X10a — Git LFS pointers (spec v1), as git-lfs reads and writes them (lfs/pointer.go):
 *
 *  - written canonically: `version`, extension lines by priority, `oid sha256:<hex>`, `size`;
 *    an empty file is its own (empty) pointer;
 *  - read from at most the first 1024 bytes, whitespace-trimmed, line by line (CRLF too, blank
 *    lines skipped): `key value`, `version` first, then `oid`, then `size`; `ext-<digit>-<name>`
 *    lines anywhere among them; nothing after `size`. The version is spec v1 (or its old hawser
 *    alias), the oid 64 lowercase hex, the size a decimal integer ≥ 0 (Go's ParseInt: a sign is
 *    allowed). Anything else is not a pointer — git lfs smudge passes it through.
 */
export interface Pointer {
  oid: string;
  size: number;
  extensions?: { name: string; priority: number; oid: string }[];
}

const enc = new TextEncoder();
const dec = new TextDecoder();
const VERSIONS = new Set([
  "https://git-lfs.github.com/spec/v1",
  "https://hawser.github.com/spec/v1",
]);
const KEYS = ["version", "oid", "size"] as const;
const OID = /^[0-9a-f]{64}$/;
const EXT = /^ext-(\d)-(\w+)$/;
/** git-lfs's blobSizeCutoff: a pointer is read from this many bytes at most */
export const MAX_POINTER_SIZE = 1024;

export function encodePointer(p: Pointer): Uint8Array {
  if (p.size === 0) return new Uint8Array(0);
  const ext = [...(p.extensions ?? [])]
    .sort((a, b) => a.priority - b.priority)
    .map((e) => `ext-${e.priority}-${e.name} sha256:${e.oid}\n`)
    .join("");
  return enc.encode(
    `version https://git-lfs.github.com/spec/v1\n${ext}oid sha256:${p.oid}\nsize ${p.size}\n`,
  );
}

export function parsePointer(bytes: Uint8Array): Pointer | undefined {
  const text = dec.decode(bytes.subarray(0, MAX_POINTER_SIZE)).trim();
  if (!text) return undefined;
  const values = new Map<string, string>();
  const extensions: { name: string; priority: number; oid: string }[] = [];
  let line = 0;
  for (let raw of text.split("\n")) {
    if (raw.endsWith("\r")) raw = raw.slice(0, -1);
    if (!raw) continue;
    const sp = raw.indexOf(" ");
    if (sp < 0) return undefined;
    const key = raw.slice(0, sp);
    const value = raw.slice(sp + 1);
    if (line >= KEYS.length) return undefined; // a line after size
    const ext = EXT.exec(key);
    if (ext) {
      if (!value.startsWith("sha256:") || !OID.test(value.slice(7))) return undefined;
      extensions.push({ priority: Number(ext[1]), name: ext[2] as string, oid: value.slice(7) });
      continue;
    }
    if (key !== KEYS[line]) return undefined;
    values.set(key, value);
    line++;
  }
  const version = values.get("version");
  const oid = values.get("oid");
  const size = values.get("size");
  if (!version || !VERSIONS.has(version) || oid === undefined || size === undefined)
    return undefined;
  if (!oid.startsWith("sha256:") || !OID.test(oid.slice(7))) return undefined;
  if (!/^[+-]?\d+$/.test(size)) return undefined;
  const n = Number(size);
  if (!Number.isSafeInteger(n) || n < 0) return undefined;
  const p: Pointer = { oid: oid.slice(7), size: n };
  if (extensions.length) p.extensions = extensions;
  return p;
}
