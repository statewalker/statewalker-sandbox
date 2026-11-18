import { readdir, readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { compileTaskSchema } from "./task-schema.ts";
import type { TaskDefinition, TaskSchema } from "./types.ts";

/** Command prefix per script extension (without the dot), as in Observable Framework data loaders. */
export type Launchers = Record<string, string[]>;

const NODE = ["node", "--disable-warning=ExperimentalWarning"];

export const DEFAULT_LAUNCHERS: Launchers = {
  js: NODE,
  mjs: NODE,
  cjs: NODE,
  ts: NODE, // Node >= 22.18 strips types natively; use ["tsx"] or ["bun"] for older runtimes.
  mts: NODE,
  py: ["python3"],
  sh: ["bash"],
  rb: ["ruby"],
  r: ["Rscript"],
  R: ["Rscript"],
};

/** `[command, ...args]` that runs `script`; a script with no known extension is executed directly. */
export function commandFor(script: string, launchers: Launchers = DEFAULT_LAUNCHERS): string[] {
  const ext = extname(script).slice(1);
  const prefix = ext ? launchers[ext] : undefined;
  return prefix ? [...prefix, script] : [script];
}

/**
 * Builds task definitions from a directory, like Observable Framework data loaders:
 * `<name>.<ext>` is the job script of task `<name>`, `<name>.cleanup.<ext>` its cleanup script and
 * `<name>.schema.json` its schema (`TaskSchema`). Only extensions with a launcher count; a cleanup
 * script without a job script is ignored. A task whose schema file is not JSON or does not compile
 * is left out, and `onSkip` is told why; the other tasks still load.
 */
export async function discoverTasks(
  directory: string,
  launchers: Launchers = DEFAULT_LAUNCHERS,
  onSkip: (task: string, reason: string) => void = () => {},
): Promise<TaskDefinition[]> {
  const dir = resolve(directory);
  const scripts = new Map<string, string>();
  const cleanups = new Map<string, string>();
  const schemas = new Map<string, string>();
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (entry.name.endsWith(".schema.json")) {
      schemas.set(entry.name.slice(0, -".schema.json".length), join(dir, entry.name));
      continue;
    }
    const ext = extname(entry.name);
    if (!launchers[ext.slice(1)]) continue;
    const stem = entry.name.slice(0, -ext.length);
    if (stem.endsWith(".cleanup"))
      cleanups.set(stem.slice(0, -".cleanup".length), join(dir, entry.name));
    else if (stem && !stem.includes(".")) scripts.set(stem, join(dir, entry.name));
  }
  const tasks: TaskDefinition[] = [];
  for (const [name, script] of [...scripts].sort(([a], [b]) => a.localeCompare(b))) {
    const task: TaskDefinition = { name, script };
    const cleanup = cleanups.get(name);
    if (cleanup) task.cleanup = cleanup;
    const schemaFile = schemas.get(name);
    if (schemaFile) {
      try {
        task.schema = await readSchema(schemaFile);
      } catch (e) {
        onSkip(name, (e as Error).message);
        continue;
      }
    }
    tasks.push(task);
  }
  return tasks;
}

async function readSchema(file: string): Promise<TaskSchema> {
  let schema: TaskSchema;
  try {
    schema = JSON.parse(await readFile(file, "utf8")) as TaskSchema;
  } catch (e) {
    throw new Error(`${file} is not valid JSON: ${(e as Error).message}`);
  }
  try {
    compileTaskSchema(schema);
  } catch (e) {
    throw new Error(`${file}: ${(e as Error).message}`);
  }
  return schema;
}
