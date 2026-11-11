/**
 * X14 — git's index file (read-cache.c): versions 2, 3 and 4, extensions kept as they are.
 *
 * Header "DIRC", version, entry count; entries sorted by name then stage; extensions (signature,
 * size, data); a SHA-1 of everything before it. An entry is its stat data (ctime, mtime, dev, ino,
 * mode, uid, gid, size: 32 bits each), the object id, flags (assume-valid, extended, stage, name
 * length) and, when extended (version 3+), more flags (skip-worktree, intent-to-add). Versions 2
 * and 3 pad each entry with 1–8 NULs to a multiple of 8; version 4 drops the padding and stores each
 * name as the number of bytes to drop from the previous name (a git offset varint) and the rest.
 */

import { createSha1, toHex } from "../../01-streaming-git-hash/src/git-object-hash.js";

export interface IndexEntry {
  ctimeSec: number;
  ctimeNsec: number;
  mtimeSec: number;
  mtimeNsec: number;
  dev: number;
  ino: number;
  mode: number;
  uid: number;
  gid: number;
  size: number;
  oid: string;
  stage: 0 | 1 | 2 | 3;
  assumeValid: boolean;
  skipWorktree: boolean;
  intentToAdd: boolean;
  path: string;
  /** the name's bytes when they are not UTF-8 (`path` then holds a lossy decoding) */
  pathBytes?: Uint8Array;
}
export interface IndexExtension {
  signature: string;
  data: Uint8Array;
}
export interface IndexFile {
  version: 2 | 3 | 4;
  entries: IndexEntry[];
  extensions: IndexExtension[];
}

const CE_VALID = 0x8000;
const CE_EXTENDED = 0x4000;
const CE_STAGEMASK = 0x3000;
const CE_NAMEMASK = 0x0fff;
const CE_SKIP_WORKTREE = 0x4000;
const CE_INTENT_TO_ADD = 0x2000;
const enc = new TextEncoder();
const dec = new TextDecoder();
const strict = new TextDecoder("utf-8", { fatal: true });

/** a name's bytes, as stored in the index */
export function nameBytes(e: Pick<IndexEntry, "path" | "pathBytes">): Uint8Array {
  return e.pathBytes ?? enc.encode(e.path);
}
function hasExtendedFlags(e: IndexEntry): boolean {
  return e.skipWorktree || e.intentToAdd;
}

export function parseIndex(bytes: Uint8Array): IndexFile {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dec.decode(bytes.subarray(0, 4)) !== "DIRC") throw new Error("index: bad signature");
  const version = view.getUint32(4);
  if (version < 2 || version > 4) throw new Error(`index: version ${version}`);
  const count = view.getUint32(8);
  const end = bytes.length - 20;
  const sum = createSha1("noble").update(bytes.subarray(0, end)).digest();
  if (toHex(sum) !== toHex(bytes.subarray(end))) throw new Error("index: bad checksum");
  const entries: IndexEntry[] = [];
  let at = 12;
  let previous: Uint8Array = new Uint8Array(0);
  for (let i = 0; i < count; i++) {
    const start = at;
    const u32 = (k: number) => view.getUint32(start + 4 * k);
    const oid = toHex(bytes.subarray(start + 40, start + 60));
    const flags = view.getUint16(start + 60);
    let flags2 = 0;
    at = start + 62;
    if (flags & CE_EXTENDED) {
      flags2 = view.getUint16(at);
      at += 2;
    }
    let name: Uint8Array;
    if (version === 4) {
      // the bytes to drop from the previous name, then the rest up to a NUL
      let c = bytes[at++] as number;
      let strip = c & 127;
      while (c & 128) {
        c = bytes[at++] as number;
        strip = ((strip + 1) << 7) | (c & 127);
      }
      const nul = bytes.indexOf(0, at);
      const head = previous.subarray(0, previous.length - strip);
      name = new Uint8Array(head.length + nul - at);
      name.set(head);
      name.set(bytes.subarray(at, nul), head.length);
      at = nul + 1;
    } else {
      const nul = bytes.indexOf(0, at);
      name = bytes.subarray(at, nul);
      at = start + ((at - start + name.length + 8) & ~7);
    }
    previous = name;
    let path: string;
    let pathBytes: Uint8Array | undefined;
    try {
      path = strict.decode(name);
    } catch {
      path = dec.decode(name);
      pathBytes = name.slice();
    }
    entries.push({
      ctimeSec: u32(0),
      ctimeNsec: u32(1),
      mtimeSec: u32(2),
      mtimeNsec: u32(3),
      dev: u32(4),
      ino: u32(5),
      mode: u32(6),
      uid: u32(7),
      gid: u32(8),
      size: u32(9),
      oid,
      stage: ((flags & CE_STAGEMASK) >> 12) as 0 | 1 | 2 | 3,
      assumeValid: !!(flags & CE_VALID),
      skipWorktree: !!(flags2 & CE_SKIP_WORKTREE),
      intentToAdd: !!(flags2 & CE_INTENT_TO_ADD),
      path,
      ...(pathBytes ? { pathBytes } : {}),
    });
  }
  const extensions: IndexExtension[] = [];
  while (at < end) {
    const signature = dec.decode(bytes.subarray(at, at + 4));
    // read-cache.c: a signature not starting with A-Z is required to read the index right
    if (!/^[A-Z]/.test(signature))
      throw new Error(`index uses ${signature} extension, which we do not understand`);
    const size = view.getUint32(at + 4);
    extensions.push({ signature, data: bytes.slice(at + 8, at + 8 + size) });
    at += 8 + size;
  }
  return { version: version as 2 | 3 | 4, entries, extensions };
}

/** git's offset varint (encode_varint) */
function varint(value: number): number[] {
  const out = [value & 127];
  let v = value >>> 7;
  while (v) {
    v -= 1;
    out.unshift(128 | (v & 127));
    v >>>= 7;
  }
  return out;
}

export function serializeIndex(index: IndexFile): Uint8Array {
  // do_write_index: version 3 exactly when an entry has extended flags (4 stays 4)
  const extendedAny = index.entries.some(hasExtendedFlags);
  const version = index.version === 4 ? 4 : extendedAny ? 3 : 2;
  const parts: Uint8Array[] = [];
  const header = new Uint8Array(12);
  header.set(enc.encode("DIRC"));
  const hv = new DataView(header.buffer);
  hv.setUint32(4, version);
  hv.setUint32(8, index.entries.length);
  parts.push(header);
  let previous: Uint8Array = new Uint8Array(0);
  for (const e of index.entries) {
    const name = nameBytes(e);
    const extended = hasExtendedFlags(e);
    const fixed = new Uint8Array(62 + (extended ? 2 : 0));
    const v = new DataView(fixed.buffer);
    [
      e.ctimeSec,
      e.ctimeNsec,
      e.mtimeSec,
      e.mtimeNsec,
      e.dev,
      e.ino,
      e.mode,
      e.uid,
      e.gid,
      e.size,
    ].forEach((x, k) => {
      v.setUint32(4 * k, x >>> 0);
    });
    for (let i = 0; i < 20; i++) fixed[40 + i] = Number.parseInt(e.oid.slice(2 * i, 2 * i + 2), 16);
    v.setUint16(
      60,
      (e.assumeValid ? CE_VALID : 0) |
        (extended ? CE_EXTENDED : 0) |
        (e.stage << 12) |
        Math.min(name.length, CE_NAMEMASK),
    );
    if (extended)
      v.setUint16(
        62,
        (e.skipWorktree ? CE_SKIP_WORKTREE : 0) | (e.intentToAdd ? CE_INTENT_TO_ADD : 0),
      );
    parts.push(fixed);
    if (version === 4) {
      let common = 0;
      while (common < previous.length && common < name.length && previous[common] === name[common])
        common++;
      parts.push(Uint8Array.from(varint(previous.length - common)));
      const rest = new Uint8Array(name.length - common + 1);
      rest.set(name.subarray(common));
      parts.push(rest);
    } else {
      const len = fixed.length + name.length;
      const padded = (len + 8) & ~7;
      const tail = new Uint8Array(padded - fixed.length);
      tail.set(name);
      parts.push(tail);
    }
    previous = name;
  }
  for (const x of index.extensions) {
    const head = new Uint8Array(8);
    head.set(enc.encode(x.signature));
    new DataView(head.buffer).setUint32(4, x.data.length);
    parts.push(head, x.data);
  }
  const body = concat(parts);
  const sum = createSha1("noble").update(body).digest();
  return concat([body, sum]);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** index order: names as bytes, then stage */
export function compareEntries(a: IndexEntry, b: IndexEntry): number {
  const x = nameBytes(a);
  const y = nameBytes(b);
  for (let i = 0; i < x.length && i < y.length; i++)
    if (x[i] !== y[i]) return (x[i] as number) - (y[i] as number);
  return x.length - y.length || a.stage - b.stage;
}
