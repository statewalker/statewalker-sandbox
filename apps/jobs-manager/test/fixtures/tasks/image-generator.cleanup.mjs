// Cleanup for image-generator: receives the job's recorded messages (JSONL) on stdin and deletes
// every object key they reported.
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";

const { bucket } = JSON.parse(process.env.JOB_PARAMS);
for await (const line of createInterface({ input: process.stdin })) {
  const { message } = JSON.parse(line);
  if (message?.key) {
    await rm(join(bucket, message.key), { force: true });
    console.log(JSON.stringify({ deleted: message.key }));
  }
}
await rm(join(bucket, process.env.JOB_ID), { recursive: true, force: true });
