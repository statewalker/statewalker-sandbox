import { copyFile, mkdir, readdir, rm, stat } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { DEFAULT_LAUNCHERS, type Launchers } from "./launchers.ts";

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
  if (!launchers[ext.slice(1)]) throw new Error(`no launcher for "${ext || script}" scripts`);
  const name = options.name ?? basename(script, ext);
  if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new Error(`invalid task name "${name}"`);
  await stat(script); // a clear ENOENT before anything is written
  await mkdir(dir, { recursive: true });
  if ((await taskFiles(dir, name)).length > 0) throw new Error(`task "${name}" already exists`);

  const files = [join(dir, `${name}${ext}`)];
  await copyFile(script, files[0] as string);
  if (options.cleanup) {
    const cleanupExt = extname(options.cleanup);
    if (!launchers[cleanupExt.slice(1)]) throw new Error(`no launcher for "${cleanupExt}" scripts`);
    const target = join(dir, `${name}.cleanup${cleanupExt}`);
    await copyFile(options.cleanup, target);
    files.push(target);
  }
  return { name, files };
}

/** Deletes a task's script and cleanup script; resolves with the removed files. */
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
      return stem === name || stem === `${name}.cleanup`;
    })
    .map((f) => join(dir, f));
}
