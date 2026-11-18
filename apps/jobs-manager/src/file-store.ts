import { createWriteStream } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, stat, truncate, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { isSafeId } from "./ids.ts";
import type { ByteInput, JobId, JobInfo, JobMessage } from "./types.ts";

/**
 * One directory per job under `root`:
 *
 *   <id>/job.json        JobInfo, rewritten atomically on every status change
 *   <id>/messages.jsonl  every JobMessage, appended in order
 *   <id>/input           the input stream, spooled before the job is queued (optional)
 *   <id>/work/           scratch directory handed to the script as JOB_DIR
 */
export class FileJobStore {
  readonly root: string;
  #appends = new Map<JobId, Promise<void>>();

  constructor(root: string) {
    this.root = root;
  }

  dir(id: JobId) {
    return join(this.root, id);
  }
  workDir(id: JobId) {
    return join(this.dir(id), "work");
  }
  messagesFile(id: JobId) {
    return join(this.dir(id), "messages.jsonl");
  }
  inputFile(id: JobId) {
    return join(this.dir(id), "input");
  }

  async create(info: JobInfo, input?: ByteInput): Promise<void> {
    await mkdir(this.workDir(info.id), { recursive: true });
    if (input) {
      await pipeline(
        Readable.from(input as AsyncIterable<Uint8Array>),
        createWriteStream(this.inputFile(info.id)),
      );
    }
    await this.writeInfo(info);
  }

  async hasInput(id: JobId): Promise<boolean> {
    return stat(this.inputFile(id)).then(
      () => true,
      () => false,
    );
  }

  /** Rewrites job.json atomically; serialised with the job's appends so a newer state is never overwritten by an older one. */
  writeInfo(info: JobInfo): Promise<void> {
    const file = join(this.dir(info.id), "job.json");
    const tmp = `${file}.${process.pid}.tmp`;
    const data = JSON.stringify(info);
    return this.#serial(info.id, async () => {
      await writeFile(tmp, data);
      await rename(tmp, file);
    });
  }

  async readInfo(id: JobId): Promise<JobInfo | undefined> {
    if (!isSafeId(id)) return undefined;
    try {
      return JSON.parse(await readFile(join(this.dir(id), "job.json"), "utf8")) as JobInfo;
    } catch {
      return undefined;
    }
  }

  /** Appends are serialised per job, so the file order is the order of the calls. */
  append(id: JobId, message: JobMessage): Promise<void> {
    const line = `${JSON.stringify(message)}\n`;
    return this.#serial(id, () => writeFile(this.messagesFile(id), line, { flag: "a" }));
  }

  #serial(id: JobId, fn: () => Promise<void>): Promise<void> {
    const next = (this.#appends.get(id) ?? Promise.resolve()).then(fn);
    this.#appends.set(
      id,
      next.catch(() => {}),
    );
    return next;
  }

  async readMessages(id: JobId): Promise<JobMessage[]> {
    let text: string;
    try {
      text = await readFile(this.messagesFile(id), "utf8");
    } catch {
      return [];
    }
    // Only newline-terminated lines are complete; a torn tail from a crash is not a message.
    return text
      .slice(0, text.lastIndexOf("\n") + 1)
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as JobMessage);
  }

  /** Truncates a line left unterminated by a crash mid-append, so later appends start clean. */
  async repair(id: JobId): Promise<void> {
    let text: string;
    try {
      text = await readFile(this.messagesFile(id), "utf8");
    } catch {
      return;
    }
    if (text.length > 0 && !text.endsWith("\n")) {
      await truncate(
        this.messagesFile(id),
        Buffer.byteLength(text.slice(0, text.lastIndexOf("\n") + 1)),
      );
    }
  }

  async ids(): Promise<JobId[]> {
    try {
      const entries = await readdir(this.root, { withFileTypes: true });
      return entries.filter((e) => e.isDirectory() && isSafeId(e.name)).map((e) => e.name);
    } catch {
      return [];
    }
  }

  async remove(id: JobId): Promise<void> {
    await this.#appends.get(id);
    this.#appends.delete(id);
    await rm(this.dir(id), { recursive: true, force: true });
  }
}
