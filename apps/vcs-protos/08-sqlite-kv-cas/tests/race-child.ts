// One contender in R3: opens the shared database file and runs one cas; prints ok/mismatch/busy.
import { newNodeSqliteDb } from "@statewalker/db-sqlite-node";
import { sqlKvStore } from "../src/sql-kv-store.js";

const [path, id, busyMs] = process.argv.slice(2);
if (!path || !id) throw new Error("usage: race-child <path> <id> [busyMs]");
const db = await newNodeSqliteDb({ path });
if (busyMs && Number(busyMs) > 0) await db.exec(`PRAGMA busy_timeout = ${Number(busyMs)}`);
const kv = await sqlKvStore(db);
const startAt = Number(process.env.START_AT ?? "0");
while (Date.now() < startAt) {}
try {
  const ok = await kv.cas(
    "refs/heads/main",
    new TextEncoder().encode("v0"),
    new TextEncoder().encode(`p${id}`),
  );
  process.stdout.write(`${id}:${ok ? "ok" : "mismatch"}\n`);
} catch (e) {
  process.stdout.write(
    /locked|busy/i.test(String(e)) ? `${id}:busy\n` : `${id}:error ${String(e)}\n`,
  );
} finally {
  await db.close();
}
