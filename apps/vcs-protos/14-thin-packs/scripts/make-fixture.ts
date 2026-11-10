/**
 * Writes fixtures/thin.pack (git pack-objects --thin), fixtures/bases.json (the objects git's
 * index-pack --fix-thin appended: what the receiver must already have) and fixtures/completed.idx
 * (this slice's index of the completed pack, checked against git's on the way).
 *   pnpm tsx 14-thin-packs/scripts/make-fixture.ts
 */
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { git, repoWithHistory } from "../../12-index-pack/src/git-repo.js";
import { installPack } from "../src/index-pack.js";

const sender = repoWithHistory(12);
const receiver = mkdtempSync(join(tmpdir(), "x6b-fixture-"));
git(receiver, ["init", "-q", "-b", "main", "."]);
const have = git(sender, ["rev-list", "--objects", "HEAD~2"]);
git(
  receiver,
  ["index-pack", "--stdin"],
  git(sender, ["pack-objects", "--stdout", "-q"], have),
);
const thin = new Uint8Array(
  git(
    sender,
    ["pack-objects", "--revs", "--thin", "--delta-base-offset", "--stdout", "-q"],
    "HEAD\n^HEAD~2\n",
  ),
);
const before = new Set(readdirSync(join(receiver, ".git/objects/pack")));
git(receiver, ["index-pack", "--fix-thin", "--stdin"], thin);
const name = readdirSync(join(receiver, ".git/objects/pack")).find(
  (n) => n.endsWith(".pack") && !before.has(n),
) as string;
const packPath = join(receiver, ".git/objects/pack", name);
const listing = git(receiver, ["verify-pack", "-v", packPath]).toString().split("\n");
const appended = listing
  .map((l) => l.split(/\s+/))
  .filter((f) => /^[0-9a-f]{40}$/.test(f[0] ?? "") && Number(f[4]) >= thin.length - 20)
  .map((f) => ({ oid: f[0] as string, type: f[1] as string }));
const bases: Record<string, { type: string; base64: string }> = {};
for (const a of appended)
  bases[a.oid] = {
    type: a.type,
    base64: git(sender, ["cat-file", a.type, a.oid]).toString("base64"),
  };

const r = await installPack(
  new MemFilesApi(),
  "/objects/pack",
  (async function* () {
    yield thin;
  })(),
  {
    externalBase: async (oid) => {
      const b = bases[oid];
      return b
        ? { type: b.type as "blob", data: new Uint8Array(Buffer.from(b.base64, "base64")) }
        : undefined;
    },
  },
);
const out = new URL("../fixtures/", import.meta.url).pathname;
writeFileSync(join(out, "thin.pack"), thin);
writeFileSync(join(out, "bases.json"), `${JSON.stringify(bases, null, 1)}\n`);
writeFileSync(join(out, "completed.idx"), r.idx);
console.log(
  `fixture: ${thin.length} byte thin pack, ${appended.length} bases, ${r.count} objects completed, ${readFileSync(join(out, "completed.idx")).length} byte idx`,
);
