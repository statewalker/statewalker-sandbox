import { copyFile, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { DEFAULT_LAUNCHERS, type Launchers } from "./launchers.ts";
import { compileTaskSchema } from "./task-schema.ts";
import { JobsError, type TaskRegistry } from "./types.ts";

/**
 * Edits a tasks directory in the layout `discoverTasks` reads: `<name>.<ext>` is the job script,
 * `<name>.cleanup.<ext>` its cleanup script. A server started with `--tasks <dir>` re-scans the
 * directory on every request, so added and removed tasks take effect at once.
 */
export async function addTask(
  dir: string,
  script: string,
  options: { name?: string; cleanup?: string; launchers?: Launchers } = {},
): Promise<{ name: string; files: string[] }> {
  const launchers = options.launchers ?? DEFAULT_LAUNCHERS;
  const ext = extname(script);
  const name = options.name ?? basename(script, ext);
  const cleanupExt = options.cleanup ? extname(options.cleanup) : undefined;
  checkTask(name, [ext, ...(cleanupExt === undefined ? [] : [cleanupExt])], launchers, script);
  await stat(script); // a clear ENOENT before anything is written
  await checkFree(dir, name);

  const files = [join(dir, `${name}${ext}`)];
  await copyFile(script, files[0] as string);
  if (options.cleanup) {
    const target = join(dir, `${name}.cleanup${cleanupExt}`);
    await copyFile(options.cleanup, target);
    files.push(target);
  }
  return { name, files };
}

/**
 * A `TaskRegistry` over a tasks directory: an upload becomes `<name>.<ext>` (and
 * `<name>.cleanup.<ext>`, `<name>.schema.json`), the layout `discoverTasks` reads. `onChange` runs after every add or
 * remove, typically to hand the re-scanned tasks to the manager.
 */
export function folderRegistry(
  dir: string,
  onChange: () => void | Promise<void> = () => {},
  launchers: Launchers = DEFAULT_LAUNCHERS,
): TaskRegistry {
  return {
    async add({ name, ext, script, cleanup, schema }) {
      checkTask(name, [`.${ext}`], launchers);
      if (schema !== undefined) {
        try {
          compileTaskSchema(schema);
        } catch (e) {
          throw new JobsError("invalid_params", `invalid schema: ${(e as Error).message}`);
        }
      }
      await checkFree(dir, name);
      await writeFile(join(dir, `${name}.${ext}`), script);
      if (cleanup !== undefined) await writeFile(join(dir, `${name}.cleanup.${ext}`), cleanup);
      if (schema !== undefined)
        await writeFile(join(dir, `${name}.schema.json`), `${JSON.stringify(schema, null, 2)}\n`);
      await onChange();
      return { name, hasCleanup: cleanup !== undefined };
    },
    async remove(name) {
      if ((await taskFiles(dir, name)).length === 0)
        throw new JobsError("unknown_task", `Unknown task: ${name}`);
      await removeTask(dir, name);
      await onChange();
    },
  };
}

function checkTask(name: string, exts: string[], launchers: Launchers, script?: string): void {
  for (const ext of exts)
    if (!launchers[ext.slice(1)])
      throw new JobsError("invalid_params", `no launcher for "${ext || script}" scripts`);
  if (!/^[A-Za-z0-9_-]+$/.test(name))
    throw new JobsError("invalid_params", `invalid task name "${name}"`);
}

async function checkFree(dir: string, name: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  if ((await taskFiles(dir, name)).length > 0)
    throw new JobsError("invalid_params", `task "${name}" already exists`);
}

/** Deletes a task's script, cleanup script and schema; resolves with the removed files. */
export async function removeTask(dir: string, name: string): Promise<string[]> {
  const files = await taskFiles(dir, name);
  if (files.length === 0) throw new Error(`no task "${name}" in ${dir}`);
  await Promise.all(files.map((f) => rm(f)));
  return files;
}

async function taskFiles(dir: string, name: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  return entries
    .filter((f) => {
      const stem = f.slice(0, f.length - extname(f).length);
      return stem === name || stem === `${name}.cleanup` || stem === `${name}.schema`;
    })
    .map((f) => join(dir, f));
}
