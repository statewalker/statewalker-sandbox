// Test helper, run as a separate process: starts a running and a pending job, then dies by SIGKILL.
import { createJobManager } from "../src/index.ts";
import { task } from "./helpers.ts";

const root = process.argv[2];
const manager = await createJobManager({
  root,
  maxConcurrent: 1,
  tasks: [
    { ...task("sleepy", "sleepy.sh"), env: { SLEEP_SECONDS: "5" } },
    task("count", "count.py"),
  ],
});
const running = await manager.start("sleepy", null);
for await (const m of manager.logs(running)) if ("message" in m) break;
const pending = await manager.start("count", { after: "restart" }, [
  new TextEncoder().encode("one\ntwo\n"),
]);
console.log(JSON.stringify({ running, pending }));
process.kill(process.pid, "SIGKILL");
