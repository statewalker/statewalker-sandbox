#!/usr/bin/env node
// Serves every task found in a directory over the REST API.
//   jobs-server --tasks ./tasks --data ./.jobs --port 8080 [--host 0.0.0.0]
//               [--max-concurrent 4] [--retention-hours 24] [--base-path /api]
import { parseArgs } from "node:util";
import { createJobManager, createJobsHandler, discoverTasks, serve } from "./index.ts";

const { values } = parseArgs({
  options: {
    tasks: { type: "string", default: "./tasks" },
    data: { type: "string", default: "./.jobs" },
    port: { type: "string", default: "8080" },
    host: { type: "string", default: "127.0.0.1" },
    "max-concurrent": { type: "string", default: "4" },
    "retention-hours": { type: "string" },
    "base-path": { type: "string", default: "" },
  },
});

const tasks = await discoverTasks(values.tasks);
const retentionHours = values["retention-hours"] ? Number(values["retention-hours"]) : undefined;
const manager = await createJobManager({
  root: values.data,
  tasks,
  maxConcurrent: Number(values["max-concurrent"]),
  retention: retentionHours ? { maxAgeMs: retentionHours * 3_600_000 } : undefined,
});
const server = await serve(createJobsHandler(manager, { basePath: values["base-path"] }), {
  port: Number(values.port),
  host: values.host,
});

console.log(`jobs-server listening on http://${values.host}:${server.port}${values["base-path"]}`);
console.error(
  `tasks: ${tasks.map((t) => (t.cleanup ? `${t.name} (+cleanup)` : t.name)).join(", ") || "(none)"}`,
);

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await server.close();
  await manager.close(); // running jobs are recorded as interrupted
  process.exit(0);
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
