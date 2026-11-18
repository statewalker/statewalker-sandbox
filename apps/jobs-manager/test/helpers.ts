import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { JobMessage } from "../src/types.ts";

export const TASKS_DIR = fileURLToPath(new URL("./fixtures/tasks/", import.meta.url));

export function task(name: string, file: string, cleanup?: string) {
  return {
    name,
    script: join(TASKS_DIR, file),
    ...(cleanup ? { cleanup: join(TASKS_DIR, cleanup) } : {}),
  };
}

export async function tempDir(): Promise<{ path: string; remove: () => Promise<void> }> {
  const path = await mkdtemp(join(tmpdir(), "jobs-test-"));
  return { path, remove: () => rm(path, { recursive: true, force: true }) };
}

export async function collect(gen: AsyncIterable<JobMessage>): Promise<JobMessage[]> {
  const out: JobMessage[] = [];
  for await (const m of gen) out.push(m);
  return out;
}

/** Drops stamps so message sequences can be compared to literals. */
export function shapes(messages: JobMessage[]) {
  return messages.map(({ stamp: _stamp, ...rest }) => rest);
}
