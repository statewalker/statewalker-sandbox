/**
 * X10a — Git LFS pointers (spec v1), as git-lfs reads and writes them (lfs/pointer.go):
 *
 *  - written canonically: `version`, extension lines by priority, `oid sha256:<hex>`, `size`;
 *    an empty file is its own (empty) pointer;
 *  - read from at most the first 1024 bytes (a BOM kept: git-lfs refuses it), trimmed as Go's
 *    `TrimSpace` trims (Unicode spaces, NEL included), line by line (CRLF too, blank lines
 *    skipped): `key value`, `version` first, then `oid`, then `size`; `ext-<digit>-<name>` lines
 *    (a name may hold `-`) among them, one per priority (a repeated key: the last); nothing after
 *    `size`. The version is spec v1 or one of its old aliases (hawser, git-media), the oid 64
 *    lowercase hex, the size a decimal integer ≥ 0 (Go's ParseInt: a sign is allowed; above 2^53
 *    refused here, where git-lfs takes up to 2^63). Anything else is not a pointer — git lfs
 *    smudge passes it through.
 */
export interface Pointer {
  oid: string;
  size: number;
  extensions?: { name: string; priority: number; oid: string }[];
}

const enc = new TextEncoder();
// the BOM is kept: git-lfs sees it as part of the first key
const dec = new TextDecoder("utf-8", { ignoreBOM: true });
/** Go's unicode.IsSpace (what strings.TrimSpace trims) */
const GO_SPACE =
  "\t\n\v\f\r \u0085\u00A0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200A\u2028\u2029\u202F\u205F\u3000";
function goTrim(s: string): string {
  let a = 0;
  let b = s.length;
  while (a < b && GO_SPACE.includes(s[a] as string)) a++;
  while (b > a && GO_SPACE.includes(s[b - 1] as string)) b--;
  return s.slice(a, b);
}
const VERSIONS = new Set([
  "https://git-lfs.github.com/spec/v1",
  "https://hawser.github.com/spec/v1",
  "http://git-media.io/v/2",
]);
const KEYS = ["version", "oid", "size"] as const;
const OID = /^[0-9a-f]{64}$/;
/** git-lfs's extRE (not anchored at the end): the name is the rest of the key */
const EXT = /^ext-(\d)-\w+/;
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
  const text = goTrim(dec.decode(bytes.subarray(0, MAX_POINTER_SIZE)));
  if (!text) return undefined;
  const values = new Map<string, string>();
  const exts = new Map<string, string>(); // key → oid, a repeated key's last value
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
      exts.set(key, value.slice(7));
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
  const extensions: { name: string; priority: number; oid: string }[] = [];
  const priorities = new Set<number>();
  for (const [key, extOid] of exts) {
    const priority = Number(key[4]);
    if (priorities.has(priority)) return undefined; // git-lfs: duplicate priority
    priorities.add(priority);
    extensions.push({ priority, name: key.slice(6), oid: extOid });
  }
  extensions.sort((a, b) => a.priority - b.priority);
  const p: Pointer = { oid: oid.slice(7), size: n };
  if (extensions.length) p.extensions = extensions;
  return p;
}
