/**
 * Builds the X4 object corpus with native git and writes fixtures/corpus.json:
 * `{ id, type, raw }` where `raw` is base64 of the uncompressed loose object ("<type> <size>\0" + content).
 * Ordinary objects come from porcelain/plumbing; exotic ones (odd modes, extra headers, legacy tags)
 * from `git hash-object --literally`, which writes the bytes exactly as given.
 *
 *   pnpm tsx 09-git-objects/scripts/make-corpus.ts
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "x4-corpus-"));
const env = {
  ...process.env,
  GIT_AUTHOR_NAME: "A U Thor",
  GIT_AUTHOR_EMAIL: "author@example.com",
  GIT_AUTHOR_DATE: "1700000000 +0200",
  GIT_COMMITTER_NAME: "C O Mitter",
  GIT_COMMITTER_EMAIL: "committer@example.com",
  GIT_COMMITTER_DATE: "1700000100 -0130",
  GIT_CONFIG_NOSYSTEM: "1",
  HOME: dir,
};
const git = (args: string[], input?: Uint8Array | string) =>
  execFileSync("git", args, { cwd: dir, env, input, maxBuffer: 1 << 26 });
const out = (args: string[], input?: Uint8Array | string) => git(args, input).toString().trim();
const enc = new TextEncoder();
const cat = (...parts: (string | Uint8Array)[]) => {
  const bs = parts.map((p) => (typeof p === "string" ? enc.encode(p) : p));
  const r = new Uint8Array(bs.reduce((n, b) => n + b.length, 0));
  let o = 0;
  for (const b of bs) {
    r.set(b, o);
    o += b.length;
  }
  return r;
};
const hexToBytes = (h: string) =>
  Uint8Array.from(h.match(/../g) ?? [], (x) => Number.parseInt(x, 16));

git(["init", "-q", "."]);
const objects: { name: string; id: string; type: string }[] = [];
const add = (name: string, type: string, content: Uint8Array | string, literally = false) => {
  const args = ["hash-object", "-w", "-t", type, "--stdin"];
  if (literally) args.splice(1, 0, "--literally");
  const id = out(args, content);
  objects.push({ name, id, type });
  return id;
};

// --- blobs
const empty = add("blob: empty", "blob", "");
const hello = add("blob: text", "blob", "hello\n");
add(
  "blob: every byte value",
  "blob",
  Uint8Array.from({ length: 1024 }, (_, i) => i & 255),
);
add("blob: CRLF text without final newline", "blob", "line one\r\nline two\r\nno newline");
let seed = 42;
add(
  "blob: 100 KiB pseudo-random",
  "blob",
  Uint8Array.from({ length: 100 * 1024 }, () => {
    seed = (seed * 1103515245 + 12345) >>> 0;
    return seed >>> 24;
  }),
);

// --- trees
const sub = out(["mktree"], `100644 blob ${hello}\tinner.txt\n`);
objects.push({ name: "tree: one entry", id: sub, type: "tree" });
const tree = out(
  ["mktree"],
  `${[
    `100644 blob ${hello}\tREADME`,
    `100755 blob ${empty}\trun.sh`,
    `120000 blob ${hello}\tlink`,
    `160000 commit ${"1".repeat(40)}\tvendor`,
    `040000 tree ${sub}\tsrc`,
    `100644 blob ${hello}\tnaïve name with spaces.txt`,
  ].join("\n")}\n`,
);
objects.push({ name: "tree: all modes, non-ASCII name", id: tree, type: "tree" });
add(
  "tree: zero-padded mode 040000 (old tools)",
  "tree",
  cat("040000 src\0", hexToBytes(sub), "100644 z\0", hexToBytes(hello)),
  true,
);
add(
  "tree: group-writable mode 100664 (git < 1.0)",
  "tree",
  cat("100664 a\0", hexToBytes(hello)),
  true,
);
add("tree: empty", "tree", "");

// --- commits
const c1 = out(["commit-tree", tree, "-m", "root commit"]);
objects.push({ name: "commit: root", id: c1, type: "commit" });
const c2 = out(["commit-tree", sub, "-p", c1, "-m", "second\n\nwith body"]);
objects.push({ name: "commit: one parent, body", id: c2, type: "commit" });
const merge = out(["commit-tree", tree, "-p", c1, "-p", c2, "-m", "merge"]);
objects.push({ name: "commit: merge", id: merge, type: "commit" });
const who = "A U Thor <author@example.com> 1700000000 +0200";
add(
  "commit: gpgsig continuation header",
  "commit",
  `tree ${tree}\nparent ${c1}\nauthor ${who}\ncommitter ${who}\ngpgsig -----BEGIN PGP SIGNATURE-----\n \n iQEzBAABCAAdFiEE0000000000000000000000000000000000AAAA\n =abcd\n -----END PGP SIGNATURE-----\n\nsigned\n`,
  true,
);
add(
  "commit: mergetag header",
  "commit",
  `tree ${tree}\nparent ${c1}\nparent ${c2}\nauthor ${who}\ncommitter ${who}\nmergetag object ${c2}\n type commit\n tag v1\n tagger ${who}\n \n v1\n\nmerge tag v1\n`,
  true,
);
add(
  "commit: ISO-8859-1 encoding, Latin-1 bytes",
  "commit",
  cat(
    `tree ${tree}\nauthor ${who}\ncommitter ${who}\nencoding ISO-8859-1\n\ncaf`,
    Uint8Array.of(0xe9),
    "\n",
  ),
  true,
);
add(
  "commit: unknown header, no final newline",
  "commit",
  `tree ${tree}\nauthor ${who}\ncommitter ${who}\nx-custom some value\n\nno newline`,
  true,
);
add("commit: empty message", "commit", `tree ${tree}\nauthor ${who}\ncommitter ${who}\n\n`, true);
add(
  "commit: odd time zone, missing space before email",
  "commit",
  `tree ${tree}\nauthor Name<a@b> 0 +1345\ncommitter Name<a@b> 0 -0000\n\nodd\n`,
  true,
);

// --- tags
const tag = out(["mktag"], `object ${c1}\ntype commit\ntag v1.0\ntagger ${who}\n\nrelease 1.0\n`);
objects.push({ name: "tag: annotated", id: tag, type: "tag" });
add("tag: legacy, no tagger", "tag", `object ${hello}\ntype blob\ntag old\n\nfrom 2005\n`, true);

const corpus = objects.map(({ name, id, type }) => {
  const content = git(["cat-file", type, id]);
  const raw = cat(`${type} ${content.length}\0`, new Uint8Array(content));
  return { name, id, type, raw: Buffer.from(raw).toString("base64") };
});
const target = new URL("../fixtures/corpus.json", import.meta.url);
writeFileSync(target, `${JSON.stringify(corpus, null, 1)}\n`);
rmSync(dir, { recursive: true, force: true });
console.log(`wrote ${corpus.length} objects to ${target.pathname}`);
