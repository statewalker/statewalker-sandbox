// One contender in R2: tries casRef(refs/heads/main, base → <id value>) once and prints the result.
import { nodeAtomicFiles } from "../src/adapters/node.js";
import { casRef } from "../src/lockfile.js";

const [root, id, base] = process.argv.slice(2);
if (!root || !id || !base) throw new Error("usage: race-child <root> <id> <base>");
const next = id.padStart(40, "0").slice(-40);
// A shared start time so the processes really overlap.
const startAt = Number(process.env.START_AT ?? "0");
while (Date.now() < startAt) {}
const r = await casRef(nodeAtomicFiles(root), "refs/heads/main", base, next);
process.stdout.write(`${id}:${r}\n`);
