/** Git's canonical tree and commit encodings (pure: no I/O). */
export type FileMode = "100644" | "100755" | "120000" | "40000" | "160000";
export interface TreeEntry {
  mode: FileMode;
  name: string;
  oid: string;
}
export interface Person {
  name: string;
  email: string;
  /** seconds since the epoch */
  when: number;
  /** "+hhmm" / "-hhmm" */
  tz: string;
}
export interface CommitData {
  tree: string;
  parents: string[];
  author: Person;
  committer: Person;
  message: string;
}
const enc = new TextEncoder();
const dec = new TextDecoder();
const OID = /^[0-9a-f]{40}$/;
const MODES = new Set<string>(["100644", "100755", "120000", "40000", "160000"]);
const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, "0"));

function checkOid(oid: string, what: string) {
  if (!OID.test(oid)) throw new Error(`${what}: not an object id: ${oid}`);
}

/**
 * git's tree order (base_name_compare): byte order of the names, a tree's name compared as if it
 * ended in "/".
 */
function treeKey(e: TreeEntry): Uint8Array {
  return enc.encode(e.mode === "40000" ? `${e.name}/` : e.name);
}
function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return (a[i] as number) - (b[i] as number);
  return a.length - b.length;
}

/** A tree object's content, entries in git's order; refuses names git's fsck refuses. */
export function encodeTree(entries: TreeEntry[]): Uint8Array {
  const seen = new Set<string>();
  for (const e of entries) {
    if (!MODES.has(e.mode)) throw new Error(`bad mode ${e.mode} for ${e.name}`);
    if (!e.name || e.name === "." || e.name === ".." || e.name === ".git" || /[/\0]/.test(e.name))
      throw new Error(`bad tree entry name ${JSON.stringify(e.name)}`);
    if (seen.has(e.name)) throw new Error(`duplicate tree entry ${e.name}`);
    seen.add(e.name);
    checkOid(e.oid, e.name);
  }
  const sorted = [...entries].sort((a, b) => compareBytes(treeKey(a), treeKey(b)));
  const parts: Uint8Array[] = [];
  let n = 0;
  for (const e of sorted) {
    const head = enc.encode(`${e.mode} ${e.name}\0`);
    const id = Uint8Array.from(e.oid.match(/../g) as string[], (x) => Number.parseInt(x, 16));
    parts.push(head, id);
    n += head.length + 20;
  }
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
    const mode = dec.decode(bytes.subarray(p, sp));
    if (!MODES.has(mode)) throw new Error(`corrupt tree: mode ${mode}`);
    let oid = "";
    for (const b of bytes.subarray(nul + 1, nul + 21)) oid += HEX[b];
    out.push({ mode: mode as FileMode, name: dec.decode(bytes.subarray(sp + 1, nul)), oid });
    p = nul + 21;
  }
  return out;
}

const person = (p: Person) => {
  if (/[<>\n]/.test(p.name) || /[<>\n]/.test(p.email)) throw new Error("bad identity");
  if (!/^[+-]\d{4}$/.test(p.tz)) throw new Error(`bad timezone ${p.tz}`);
  return `${p.name} <${p.email}> ${Math.trunc(p.when)} ${p.tz}`;
};

export function encodeCommit(c: CommitData): Uint8Array {
  checkOid(c.tree, "tree");
  for (const p of c.parents) checkOid(p, "parent");
  const head = [
    `tree ${c.tree}`,
    ...c.parents.map((p) => `parent ${p}`),
    `author ${person(c.author)}`,
    `committer ${person(c.committer)}`,
  ];
  return enc.encode(`${head.join("\n")}\n\n${c.message}`);
}

const PERSON = /^(.*) <(.*)> (\d+) ([+-]\d{4})$/;
function parsePerson(s: string): Person {
  const m = PERSON.exec(s);
  if (!m) throw new Error(`corrupt identity: ${s}`);
  return { name: m[1] as string, email: m[2] as string, when: Number(m[3]), tz: m[4] as string };
}

/** Headers before the first empty line (continuation lines of e.g. gpgsig are skipped). */
export function parseCommit(bytes: Uint8Array): CommitData {
  const text = dec.decode(bytes);
  const cut = text.indexOf("\n\n");
  const header = cut < 0 ? text : text.slice(0, cut);
  const message = cut < 0 ? "" : text.slice(cut + 2);
  let tree = "";
  const parents: string[] = [];
  let author: Person | undefined;
  let committer: Person | undefined;
  for (const line of header.split("\n")) {
    if (line.startsWith(" ")) continue;
    const sp = line.indexOf(" ");
    const key = line.slice(0, sp);
    const value = line.slice(sp + 1);
    if (key === "tree") tree = value;
    else if (key === "parent") parents.push(value);
    else if (key === "author") author = parsePerson(value);
    else if (key === "committer") committer = parsePerson(value);
  }
  if (!OID.test(tree) || !author || !committer) throw new Error("corrupt commit");
  return { tree, parents, author, committer, message };
}
