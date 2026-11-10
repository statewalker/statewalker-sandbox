/**
 * Writes fixtures/sample.pack and fixtures/sample.idx (the .idx produced by native `git index-pack`)
 * for the Chromium and Durable Object runs.  pnpm tsx 12-index-pack/scripts/make-fixture.ts
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitEnv, packAll, repoWithHistory } from "../src/git-repo.js";

const repo = repoWithHistory(40);
const pack = packAll(repo, true);
const dir = mkdtempSync(join(tmpdir(), "x6-fixture-"));
writeFileSync(join(dir, "sample.pack"), pack);
execFileSync("git", ["index-pack", "-o", join(dir, "sample.idx"), join(dir, "sample.pack")], {
  env: gitEnv,
});
const out = new URL("../fixtures/", import.meta.url).pathname;
copyFileSync(join(dir, "sample.pack"), join(out, "sample.pack"));
copyFileSync(join(dir, "sample.idx"), join(out, "sample.idx"));
console.log(
  `fixture: ${pack.length} byte pack, ${readFileSync(join(out, "sample.idx")).length} byte idx`,
);
