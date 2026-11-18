import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createReadStream, existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { FileJobStore } from "./file-store.ts";
import { lines, parseLine } from "./jsonl.ts";
import { commandFor, DEFAULT_LAUNCHERS, type Launchers } from "./launchers.ts";
import { nextStamp } from "./stamps.ts";
import {
  type ByteInput,
  type CleanupResult,
  isTerminal,
  type JobId,
  type JobInfo,
  type JobManager,
  type JobMessage,
  type JobStatus,
  JobsError,
  type JobTimeStamp,
  type Json,
  type ListFilter,
  type LogsOptions,
  type TaskDefinition,
  type TaskInfo,
} from "./types.ts";

export type JobManagerOptions = {
  /** Directory holding one sub-directory per job. */
  root: string;
  tasks: TaskDefinition[];
  /** Merged over DEFAULT_LAUNCHERS. */
  launchers?: Launchers;
  /** Jobs running at once; the rest wait as `pending`. Default 4. */
  maxConcurrent?: number;
  /** Time between SIGTERM and SIGKILL when interrupting. Default 5000 ms. */
  killGraceMs?: number;
  /** Periodically clean up jobs that finished more than `maxAgeMs` ago. */
  retention?: { maxAgeMs: number; intervalMs?: number };
};

type MessageBody = JobMessage extends infer M
  ? M extends JobMessage
    ? Omit<M, "stamp">
    : never
  : never;

/** In-memory state of a job this process owns (pending or running). */
type Live = {
  info: JobInfo;
  last: JobTimeStamp;
  listeners: Set<(message: JobMessage) => void>;
  child?: ChildProcess;
  interrupting?: boolean;
  finished: Promise<void>;
  finish: () => void;
};

/**
 * Kills the process group a crashed manager left behind. Where /proc exists, only if a member of
 * the group still carries this job's JOB_ID, so a recycled group id is never hit.
 */
function killOrphanGroup(pgid: number, id: JobId): void {
  if (existsSync("/proc")) {
    let found = false;
    for (const pid of readdirSync("/proc").filter((d) => /^\d+$/.test(d))) {
      try {
        const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
        const pgrp = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[2]);
        if (pgrp !== pgid) continue;
        if (readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").includes(`JOB_ID=${id}`)) {
          found = true;
          break;
        }
      } catch {
        // process vanished or is not ours
      }
    }
    if (!found) return;
  }
  try {
    process.kill(-pgid, "SIGKILL");
  } catch {
    // already gone
  }
}

export async function createJobManager(options: JobManagerOptions): Promise<ProcessJobManager> {
  const manager = new ProcessJobManager(options);
  await manager.init();
  return manager;
}

/** Runs each job as a child process; persists everything through a FileJobStore. */
export class ProcessJobManager implements JobManager {
  readonly #store: FileJobStore;
  readonly #tasks = new Map<string, TaskDefinition>();
  readonly #launchers: Launchers;
  readonly #live = new Map<JobId, Live>();
  readonly #queue: Live[] = [];
  readonly #maxConcurrent: number;
  readonly #killGraceMs: number;
  #running = 0;
  #cleaning: Promise<unknown> = Promise.resolve();
  #retentionTimer?: NodeJS.Timeout;

  constructor(options: JobManagerOptions) {
    this.#store = new FileJobStore(resolve(options.root));
    this.#launchers = { ...DEFAULT_LAUNCHERS, ...options.launchers };
    this.#maxConcurrent = Math.max(1, options.maxConcurrent ?? 4);
    this.#killGraceMs = options.killGraceMs ?? 5000;
    const retention = options.retention;
    if (retention) {
      const interval = retention.intervalMs ?? Math.max(1000, retention.maxAgeMs / 10);
      this.#retentionTimer = setInterval(() => {
        void this.cleanup(nextStamp() - retention.maxAgeMs).catch(() => {});
      }, interval);
      this.#retentionTimer.unref();
    }
    for (const task of options.tasks) this.#tasks.set(task.name, task);
  }

  /**
   * Recovers jobs left by a previous process on the same root: a `running` job lost its process
   * and becomes `interrupted`; a `pending` job (input already spooled) is queued again.
   * One manager per root directory: a second live manager would claim the first one's jobs.
   */
  async init(): Promise<void> {
    for (const id of await this.#store.ids()) {
      const info = await this.#store.readInfo(id);
      if (!info || isTerminal(info.status)) continue;
      await this.#store.repair(id); // drop a line torn by a crash mid-append
      const messages = await this.#store.readMessages(id);
      const last = messages.at(-1);
      if (last && isTerminal(last.status)) {
        // the final message was written but job.json was not: the messages are the truth
        await this.#store.writeInfo({
          ...info,
          status: last.status,
          updated: last.stamp,
          pid: undefined,
        });
        continue;
      }
      const live = this.#newLive(info, last?.stamp ?? info.updated);
      if (info.status === "running") {
        if (info.pid) killOrphanGroup(info.pid, id);
        await this.#record(live, {
          status: "interrupted",
          error: { code: "restart", message: "The manager stopped while the job was running" },
        });
      } else if (!this.#tasks.has(info.task)) {
        await this.#record(live, {
          status: "error",
          error: { code: "unknown_task", message: info.task },
        });
      } else {
        this.#live.set(id, live);
        this.#enqueue(live);
      }
    }
  }

  #newLive(info: JobInfo, last: JobTimeStamp): Live {
    let finish!: () => void;
    const finished = new Promise<void>((r) => (finish = r));
    return { info, last, listeners: new Set(), finished, finish };
  }

  async tasks(): Promise<TaskInfo[]> {
    return [...this.#tasks.values()].map((t) => ({ name: t.name, hasCleanup: Boolean(t.cleanup) }));
  }

  /**
   * Replaces the registered tasks, e.g. after re-scanning a tasks directory. Running jobs keep the
   * definition they started with; a pending job whose task disappeared fails with `unknown_task`.
   */
  setTasks(tasks: TaskDefinition[]): void {
    this.#tasks.clear();
    for (const task of tasks) this.#tasks.set(task.name, task);
  }

  async start(task: string, params: Json = null, input?: ByteInput): Promise<JobId> {
    if (!this.#tasks.has(task)) throw new JobsError("unknown_task", `Unknown task: ${task}`);
    const id = randomUUID();
    const stamp = nextStamp();
    const info: JobInfo = { id, task, params, status: "pending", created: stamp, updated: stamp };
    const live = this.#newLive(info, 0);
    this.#live.set(id, live);
    try {
      await this.#store.create(info, input);
      await this.#record(live, { status: "pending" }, stamp);
    } catch (e) {
      // e.g. the input stream failed mid-upload: forget the job entirely
      this.#live.delete(id);
      live.finish();
      await this.#store.remove(id).catch(() => {});
      throw e;
    }
    this.#enqueue(live);
    return id;
  }

  async *logs(
    id: JobId,
    since: JobTimeStamp = 0,
    options: LogsOptions = {},
  ): AsyncGenerator<JobMessage> {
    const { follow = true, signal } = options;
    await this.info(id);
    const live = follow ? this.#live.get(id) : undefined;
    const queue: JobMessage[] = [];
    let wake: (() => void) | undefined;
    const listener = (message: JobMessage) => {
      queue.push(message);
      wake?.();
    };
    // Subscribe before reading the file: anything recorded meanwhile is in both, and the stamps dedupe it.
    live?.listeners.add(listener);
    try {
      let last = since;
      for (const message of await this.#store.readMessages(id)) {
        if (signal?.aborted) return;
        if (message.stamp <= last) continue;
        yield message;
        last = message.stamp;
        if (isTerminal(message.status)) return;
      }
      if (!live) return;
      const onAbort = () => wake?.();
      signal?.addEventListener("abort", onAbort);
      try {
        while (!signal?.aborted) {
          while (queue.length > 0) {
            const message = queue.shift()!;
            if (message.stamp <= last) continue;
            yield message;
            last = message.stamp;
            if (isTerminal(message.status)) return;
          }
          if (signal?.aborted) return; // may have aborted while the consumer held the last message
          await new Promise<void>((r) => (wake = r));
          wake = undefined;
        }
      } finally {
        signal?.removeEventListener("abort", onAbort);
      }
    } finally {
      live?.listeners.delete(listener);
    }
  }

  async info(id: JobId): Promise<JobInfo> {
    const live = this.#live.get(id);
    if (live) return { ...live.info };
    const info = await this.#store.readInfo(id);
    if (!info) throw new JobsError("unknown_job", `Unknown job: ${id}`);
    return info;
  }

  async status(id: JobId): Promise<JobStatus> {
    return (await this.info(id)).status;
  }

  async interrupt(id: JobId): Promise<JobStatus> {
    const live = this.#live.get(id);
    if (!live) return this.status(id);
    const queued = this.#queue.indexOf(live);
    if (queued >= 0) {
      this.#queue.splice(queued, 1);
      await this.#record(live, { status: "interrupted" });
      this.#live.delete(id);
      live.finish();
      return "interrupted";
    }
    live.interrupting = true;
    if (live.child) this.#kill(live.child);
    await live.finished;
    return live.info.status;
  }

  async *list(filter: ListFilter = {}): AsyncGenerator<JobInfo> {
    const statuses = filter.status === undefined ? undefined : [filter.status].flat();
    for (const id of await this.#store.ids()) {
      const info = this.#live.get(id)?.info ?? (await this.#store.readInfo(id));
      if (!info) continue;
      if (statuses && !statuses.includes(info.status)) continue;
      if (filter.task !== undefined && info.task !== filter.task) continue;
      yield { ...info };
    }
  }

  /** Cleanups run one at a time, so a timer tick never races an explicit call. */
  cleanup(before: JobTimeStamp = Date.now()): Promise<CleanupResult> {
    const run = this.#cleaning.then(() => this.#cleanup(before));
    this.#cleaning = run.catch(() => {});
    return run;
  }

  async #cleanup(before: JobTimeStamp): Promise<CleanupResult> {
    const result: CleanupResult = { removed: [], failed: [] };
    for (const id of await this.#store.ids()) {
      if (this.#live.has(id)) continue;
      const info = await this.#store.readInfo(id);
      // To the millisecond: a job that finished in the same millisecond as `before` counts as before it.
      if (!info || !isTerminal(info.status) || Math.floor(info.updated) > before) continue;
      const def = this.#tasks.get(info.task);
      if (def?.cleanup) {
        const error = await this.#runCleanup(def, info);
        if (error) {
          result.failed.push({ id, error });
          continue;
        }
      }
      await this.#store.remove(id);
      result.removed.push(id);
    }
    return result;
  }

  /** Runs the cleanup script with the job's messages on stdin; resolves with an error text on failure. */
  #runCleanup(def: TaskDefinition, info: JobInfo): Promise<string | undefined> {
    const [command, ...args] = commandFor(def.cleanup!, this.#launchers);
    return new Promise((resolveRun) => {
      const child = spawn(command, args, {
        cwd: def.cwd ?? dirname(def.cleanup!),
        env: this.#env(def, info),
        stdio: ["pipe", "ignore", "pipe"],
      });
      let stderr = "";
      child
        .stderr!.setEncoding("utf8")
        .on("data", (d: string) => (stderr = (stderr + d).slice(-4000)));
      child.stdin!.on("error", () => {});
      createReadStream(this.#store.messagesFile(info.id))
        .on("error", () => child.stdin!.end())
        .pipe(child.stdin!);
      child.once("error", (e) => resolveRun(`cleanup could not start: ${e.message}`));
      child.once("close", (code, signal) =>
        resolveRun(
          code === 0 ? undefined : `cleanup exited with ${signal ?? code}: ${stderr.trim()}`,
        ),
      );
    });
  }

  #env(def: TaskDefinition, info: JobInfo): NodeJS.ProcessEnv {
    return {
      ...process.env,
      ...def.env,
      JOB_ID: info.id,
      JOB_TASK: info.task,
      JOB_PARAMS: JSON.stringify(info.params),
      JOB_DIR: this.#store.workDir(info.id),
    };
  }

  /** Interrupts every pending and running job of this manager and waits for them to finish. */
  async close(): Promise<void> {
    clearInterval(this.#retentionTimer);
    await this.#cleaning;
    await Promise.all([...this.#live.keys()].map((id) => this.interrupt(id)));
  }

  #enqueue(live: Live): void {
    this.#queue.push(live);
    this.#pump();
  }

  #pump(): void {
    while (this.#running < this.#maxConcurrent && this.#queue.length > 0) {
      const live = this.#queue.shift()!;
      this.#running++;
      void this.#run(live).finally(() => {
        this.#running--;
        this.#pump();
      });
    }
  }

  /**
   * SIGTERM to the whole process group, SIGKILL to the group after the grace period. The SIGKILL is
   * sent even if the script itself has exited by then: processes it started may ignore SIGTERM.
   */
  #kill(child: ChildProcess): void {
    const signal = (sig: NodeJS.Signals) => {
      try {
        process.kill(-child.pid!, sig);
      } catch {
        // group already gone
      }
    };
    signal("SIGTERM");
    setTimeout(() => signal("SIGKILL"), this.#killGraceMs).unref();
  }

  async #run(live: Live): Promise<void> {
    const { id, task } = live.info;
    const def = this.#tasks.get(task);
    try {
      if (!def) {
        await this.#record(live, {
          status: "error",
          error: { code: "unknown_task", message: task },
        });
        return;
      }
      if (live.interrupting) {
        // interrupted while its input was still being stored: never spawn it
        await this.#record(live, { status: "interrupted" });
        return;
      }
      const [command, ...args] = commandFor(def.script, this.#launchers);
      const hasInput = await this.#store.hasInput(id);
      const child = spawn(command, args, {
        cwd: def.cwd ?? dirname(def.script),
        env: this.#env(def, live.info),
        stdio: [hasInput ? "pipe" : "ignore", "pipe", "pipe"],
        detached: true, // own process group, so an interrupt reaches the script's children too
      });
      live.child = child;
      live.info = { ...live.info, pid: child.pid }; // persisted with "running", for recovery after a crash
      if (live.interrupting) this.#kill(child);
      const exited = new Promise<{
        code: number | null;
        signal: NodeJS.Signals | null;
        error?: Error;
      }>((r) => {
        child.once("error", (error) => r({ code: null, signal: null, error }));
        child.once("close", (code, signal) => r({ code, signal }));
      });
      // Everything up to the readers must stay synchronous: when the child exits, Node discards
      // stdout/stderr that has no reader attached yet (flushStdio), so a fast script would lose its output.
      // #record takes its stamp synchronously, so "running" still precedes every line.
      const running = this.#record(live, { status: "running" });
      const stdout = (async () => {
        for await (const line of lines(child.stdout!)) {
          if (line.trim())
            await this.#record(live, { status: "running", message: parseLine(line) });
        }
      })();
      const stderrTail: string[] = [];
      const stderr = (async () => {
        for await (const line of lines(child.stderr!)) {
          if (!line.trim()) continue;
          stderrTail.push(line);
          if (stderrTail.length > 20) stderrTail.shift();
          await this.#record(live, { status: "running", error: parseLine(line) });
        }
      })();
      if (hasInput && child.stdin) {
        child.stdin.on("error", () => {}); // the script may exit without reading all its input
        createReadStream(this.#store.inputFile(id)).pipe(child.stdin);
      }
      await running;
      const exit = await exited;
      await Promise.allSettled([stdout, stderr]);
      if (live.interrupting) {
        await this.#record(live, { status: "interrupted" });
      } else if (exit.error) {
        await this.#record(live, {
          status: "error",
          error: { code: "spawn", message: exit.error.message },
        });
      } else if (exit.code === 0) {
        await this.#record(live, { status: "done" });
      } else {
        await this.#record(live, {
          status: "error",
          error: {
            code: "exit",
            exitCode: exit.code,
            signal: exit.signal,
            stderr: stderrTail.join("\n"),
          },
        });
      }
    } catch (e) {
      await this.#record(live, {
        status: "error",
        error: { code: "internal", message: String(e) },
      }).catch(() => {});
    } finally {
      this.#live.delete(id);
      live.finish();
    }
  }

  /** Persists a message, updates job.json on a status change, then notifies followers. */
  async #record(live: Live, body: MessageBody, stamp = nextStamp(live.last)): Promise<JobMessage> {
    live.last = stamp;
    const message = { stamp, ...body } as JobMessage;
    const id = live.info.id;
    const writes = [this.#store.append(id, message)];
    if (message.status !== live.info.status || message.status === "pending") {
      live.info = { ...live.info, status: message.status, updated: stamp };
      if (isTerminal(message.status)) delete live.info.pid;
      writes.push(this.#store.writeInfo(live.info));
    }
    await Promise.all(writes);
    for (const listener of live.listeners) listener(message);
    return message;
  }
}
