/**
 * Git's canonical tree, commit and tag encodings (pure: no I/O), byte-exact on a read-modify-write:
 * tree names and modes, commit headers, identities and messages keep the bytes they were read
 * with, so re-encoding an unchanged object gives the same id. Writing new names follows git's
 * fsck rules (hasDotgit for HFS and NTFS spellings, a symlinked .gitmodules, duplicates by bytes).
 */
/** A canonical mode when writing; any octal mode is kept when read (legacy 040000, 100664…). */
export type FileMode = "100644" | "100755" | "120000" | "40000" | "160000";
export interface TreeEntry {
  mode: FileMode | string;
  /** For display and new entries; `nameBytes`, when present, is what is written. */
  name: string;
  /** The name exactly as read (not always UTF-8). */
  nameBytes?: Uint8Array;
  oid: string;
}
export interface Person {
  name: string;
  email: string;
  /** seconds since the epoch */
  when: number;
  /** "+hhmm" / "-hhmm" */
  tz: string;
  /** The identity line exactly as read (written back while the fields above still match it). */
  raw?: Uint8Array;
}
export interface CommitData {
  tree: string;
  parents: string[];
  author: Person;
  committer: Person;
  message: string;
  /** The `encoding` header, if any (the message is decoded with it). */
  encoding?: string;
  /** Headers after committer (encoding, mergetag, gpgsig…), in order, values as read. */
  extraHeaders?: { key: string; value: Uint8Array }[];
  /** The message exactly as read (written back while `message` still decodes from it). */
  messageBytes?: Uint8Array;
}

const enc = new TextEncoder();
const display = new TextDecoder("utf-8", { ignoreBOM: true });
const OID = /^[0-9a-f]{40}$/;
const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, "0"));
const toHex = (b: Uint8Array) => {
  let s = "";
  for (const x of b) s += HEX[x];
  return s;
};

function checkOid(oid: string, what: string) {
  if (!OID.test(oid)) throw new Error(`${what}: not an object id: ${oid}`);
}

/** a hex object id to its 20 bytes, by character codes (a regex per id was a measured cost) */
const oidToBytes = (h: string) => {
  // by character codes: a regex and a parseInt per byte were a measured cost on hot paths
  const out = new Uint8Array(h.length >> 1);
  for (let i = 0; i < out.length; i++) {
    const a = h.charCodeAt(2 * i);
    const b = h.charCodeAt(2 * i + 1);
    out[i] = ((a <= 57 ? a - 48 : (a | 32) - 87) << 4) | (b <= 57 ? b - 48 : (b | 32) - 87);
  }
  return out;
};

export function isTreeMode(mode: string): boolean {
  return (Number.parseInt(mode, 8) & 0o170000) === 0o040000;
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return (a[i] as number) - (b[i] as number);
  return a.length - b.length;
}

/** Code points HFS+ ignores in names (git's is_hfs_dotgit). */
const HFS_IGNORED = /[‌-‏‪-‮⁪-⁯﻿]/g;
/** The name as HFS+ and NTFS compare it: ignorables dropped, case folded, trailing dots/spaces cut. */
function folded(name: string): string {
  return name
    .replace(HFS_IGNORED, "")
    .toLowerCase()
    .replace(/[ .]+$/, "");
}
/** git fsck's hasDotgit: `.git` as any filesystem might read it (HFS+, NTFS 8.3 `git~1`). */
function isDotgit(name: string): boolean {
  const f = folded(name);
  return f === ".git" || f === "git~1";
}

function nameBytesOf(e: TreeEntry): Uint8Array {
  if (e.nameBytes) return e.nameBytes;
  if (!e.name.isWellFormed())
    throw new Error(`tree entry name is not well-formed: ${JSON.stringify(e.name)}`);
  return enc.encode(e.name);
}

/** A tree object's content, entries in git's order; refuses entries git's fsck refuses. */
export function encodeTree(entries: TreeEntry[]): Uint8Array {
  const seen = new Set<string>();
  const items = entries.map((e) => {
    if (!/^[0-7]{5,6}$/.test(e.mode)) throw new Error(`bad mode ${e.mode} for ${e.name}`);
    const bytes = nameBytesOf(e);
    const text = display.decode(bytes);
    if (
      bytes.length === 0 ||
      bytes.includes(0x2f) ||
      bytes.includes(0) ||
      text === "." ||
      text === ".." ||
      isDotgit(text)
    )
      throw new Error(`bad tree entry name ${JSON.stringify(text)}`);
    if (Number.parseInt(e.mode, 8) === 0o120000 && folded(text) === ".gitmodules")
      throw new Error(".gitmodules must not be a symbolic link (git fsck: gitmodulesSymlink)");
    const key = toHex(bytes);
    if (seen.has(key)) throw new Error(`duplicate tree entry ${JSON.stringify(text)}`);
    seen.add(key);
    checkOid(e.oid, text);
    // git's base_name_compare: a tree's name compares as if it ended in "/"
    const sortKey = isTreeMode(e.mode) ? new Uint8Array([...bytes, 0x2f]) : bytes;
    return { e, bytes, sortKey };
  });
  items.sort((a, b) => compareBytes(a.sortKey, b.sortKey));
  const parts: Uint8Array[] = [];
  let n = 0;
  for (const { e, bytes } of items) {
    const head = new Uint8Array([...enc.encode(`${e.mode} `), ...bytes, 0]);
    const id = oidToBytes(e.oid);
    parts.push(head, id);
    n += head.length + 20;
  }
  return concat(parts, n);
}

function concat(parts: Uint8Array[], n = parts.reduce((a, p) => a + p.length, 0)): Uint8Array {
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export function parseTree(bytes: Uint8Array): TreeEntry[] {
  const out: TreeEntry[] = [];
  let p = 0;
  while (p < bytes.length) {
    const sp = bytes.indexOf(0x20, p);
    const nul = bytes.indexOf(0, sp + 1);
    if (sp < 0 || nul < 0 || nul + 21 > bytes.length) throw new Error("corrupt tree");
    const mode = display.decode(bytes.subarray(p, sp));
    if (!/^[0-7]{5,6}$/.test(mode)) throw new Error(`corrupt tree: mode ${mode}`);
    const nameBytes = bytes.slice(sp + 1, nul);
    out.push({
      mode,
      name: display.decode(nameBytes),
      nameBytes,
      oid: toHex(bytes.subarray(nul + 1, nul + 21)),
    });
    p = nul + 21;
  }
  return out;
}

function formatPerson(p: Person): Uint8Array {
  if (p.raw && samePerson(parsePerson(p.raw), p)) return p.raw;
  const name = p.name.trim(); // git strips the "crud" around names and emails
  const email = p.email.trim();
  if (!name) throw new Error("empty identity name");
  if (/[<>\n\0]/.test(name) || /[<>\n\0]/.test(email)) throw new Error("bad identity");
  if (!Number.isSafeInteger(p.when) || p.when < 0) throw new Error(`bad timestamp ${p.when}`);
  if (!/^[+-]\d{4}$/.test(p.tz)) throw new Error(`bad timezone ${p.tz}`);
  return enc.encode(`${name} <${email}> ${p.when} ${p.tz}`);
}
const samePerson = (a: Person, b: Person) =>
  a.name === b.name && a.email === b.email && a.when === b.when && a.tz === b.tz;

/**
 * git's split_ident_line: never fails on what git log tolerates — no space before "<", a missing
 * date or zone, extra spaces. Missing dates read as 0, missing zones as +0000.
 */
function parsePerson(raw: Uint8Array): Person {
  const s = display.decode(raw);
  const lt = s.indexOf("<");
  const gt = s.lastIndexOf(">");
  if (lt < 0 || gt < lt) return { name: s.trim(), email: "", when: 0, tz: "+0000", raw };
  const rest = s
    .slice(gt + 1)
    .trim()
    .split(/\s+/);
  const when = /^\d+$/.test(rest[0] ?? "") ? Number(rest[0]) : 0;
  const tz = /^[+-]\d{4}$/.test(rest[1] ?? "") ? (rest[1] as string) : "+0000";
  return { name: s.slice(0, lt).trim(), email: s.slice(lt + 1, gt).trim(), when, tz, raw };
}

function decodeMessage(bytes: Uint8Array, encoding: string | undefined): string {
  if (encoding && !/^utf-?8$/i.test(encoding)) {
    try {
      return new TextDecoder(encoding).decode(bytes);
    } catch {
      // an encoding this runtime does not know: show UTF-8, keep the bytes
    }
  }
  return display.decode(bytes);
}

export function encodeCommit(c: CommitData): Uint8Array {
  checkOid(c.tree, "tree");
  for (const p of c.parents) checkOid(p, "parent");
  const line = (key: string, value: Uint8Array) =>
    concat([enc.encode(`${key} `), value, enc.encode("\n")]);
  const parts: Uint8Array[] = [line("tree", enc.encode(c.tree))];
  for (const p of c.parents) parts.push(line("parent", enc.encode(p)));
  parts.push(line("author", formatPerson(c.author)), line("committer", formatPerson(c.committer)));
  const extra = c.extraHeaders ?? [];
  if (c.encoding && !extra.some((h) => h.key === "encoding"))
    parts.push(line("encoding", enc.encode(c.encoding)));
  for (const h of extra) {
    if (
      !/^[a-z][a-z0-9-]*$/.test(h.key) ||
      ["tree", "parent", "author", "committer"].includes(h.key)
    )
      throw new Error(`bad commit header ${h.key}`);
    parts.push(line(h.key, h.value)); // a multi-line value keeps its "\n " continuations
  }
  parts.push(enc.encode("\n"));
  let message: Uint8Array;
  if (c.messageBytes && decodeMessage(c.messageBytes, c.encoding) === c.message)
    message = c.messageBytes;
  else {
    if (c.message.includes("\0")) throw new Error("a commit message must not contain NUL");
    message = enc.encode(c.message);
  }
  parts.push(message);
  return concat(parts);
}

/** Header lines up to the first empty line; continuation lines (" …") belong to the header above. */
function headers(bytes: Uint8Array): { list: { key: string; value: Uint8Array }[]; body: number } {
  const list: { key: string; value: Uint8Array }[] = [];
  let p = 0;
  while (p < bytes.length) {
    let nl = bytes.indexOf(0x0a, p);
    if (nl < 0) nl = bytes.length;
    if (nl === p) return { list, body: p + 1 };
    if (bytes[p] === 0x20 && list.length) {
      const last = list[list.length - 1] as { key: string; value: Uint8Array };
      last.value = concat([last.value, new Uint8Array([0x0a]), bytes.subarray(p, nl)]);
    } else {
      const sp = bytes.indexOf(0x20, p);
      const end = sp < 0 || sp > nl ? nl : sp;
      list.push({
        key: display.decode(bytes.subarray(p, end)),
        value: bytes.slice(Math.min(end + 1, nl), nl),
      });
    }
    p = nl + 1;
  }
  return { list, body: bytes.length };
}

export function parseCommit(bytes: Uint8Array): CommitData {
  const { list, body } = headers(bytes);
  let tree = "";
  const parents: string[] = [];
  let author: Person | undefined;
  let committer: Person | undefined;
  const extraHeaders: { key: string; value: Uint8Array }[] = [];
  let encoding: string | undefined;
  for (const h of list) {
    if (h.key === "tree") tree = display.decode(h.value);
    else if (h.key === "parent") parents.push(display.decode(h.value));
    else if (h.key === "author") author = parsePerson(h.value);
    else if (h.key === "committer") committer = parsePerson(h.value);
    else {
      extraHeaders.push(h);
      if (h.key === "encoding") encoding = display.decode(h.value);
    }
  }
  if (!OID.test(tree) || !author || !committer) throw new Error("corrupt commit");
  const messageBytes = bytes.slice(body);
  return {
    tree,
    parents,
    author,
    committer,
    message: decodeMessage(messageBytes, encoding),
    encoding,
    extraHeaders,
    messageBytes,
  };
}

/** The object an annotated tag points at (for peeling). */
export function parseTagTarget(bytes: Uint8Array): { object: string; type: string } {
  const { list } = headers(bytes);
  const object = list.find((h) => h.key === "object");
  const type = list.find((h) => h.key === "type");
  if (!object || !type) throw new Error("corrupt tag");
  return { object: display.decode(object.value), type: display.decode(type.value) };
}
