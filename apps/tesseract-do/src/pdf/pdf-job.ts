/**
 * One PDF conversion as a Durable Object.
 *
 * The PDF arrives in parts (`append`, 1 MiB each), straight into the job's SQLite: neither the
 * Worker nor the job holds the whole upload. `start` checks it and sets an alarm. Every alarm
 * converts a **batch of pages** (`pageConcurrency`, default 4) and sets the next: each alarm is
 * an invocation of its own, with its own CPU budget, so a document of any length is not bound
 * by one request. A page's images are OCR'd in the language's OcrCells over RPC, outside this
 * job's budget; with `ocrCells` > 1 they are spread over a small pool of cells, so the pages of
 * a batch are recognised in parallel.
 *
 * pdf.js reads the PDF by byte ranges from SQLite (`openPdfRanges`, no auto-fetch), so only the
 * parts of the file that the pages need are read. pdf.js still allocates one buffer of the
 * file's size for what it has read, which is why documents are capped at 64 MB here.
 *
 * Each page commits on its own (the page, its new PNG assets), so after an eviction or a
 * restart the job resumes with the pages not done yet; the alarm is durable too. A page that
 * fails is retried with a growing delay, then recorded as failed and skipped. The pdf.js
 * document is kept between alarms while the isolate lives, and reopened when it does not.
 */
import { DurableObject } from "cloudflare:workers";
import {
  type ImageAsset,
  type Language,
  languageByTesseract,
  type PageInfo,
  type PortableTextBlock,
} from "@statewalker/pdf-portabletext/core";
import type { PDFDocumentProxy } from "pdfjs-dist/legacy/build/pdf.mjs";
import { BLOB_CHUNK, BlobStore } from "../blob-store.ts";
import type { RawImage } from "../decode.ts";
import type { Sql } from "../models.ts";
import type { Env } from "../ocr-cell.ts";
import { assembleDocument, convertPage, documentLanguage } from "./convert.ts";
import { openPdfRanges, type RangeStats } from "./pdfjs.ts";

export type JobStatus = "queued" | "running" | "done" | "failed" | "cancelled";

export type JobOptions = {
  /** Tesseract language, or `auto`. */
  lang: string;
  engine: "cell" | "isolate";
  maxPages?: number;
  /** Pause between batches (ms): spreads the OCR load; tests use it to stop a job half-way. */
  throttleMs?: number;
  /** Pages converted at once by an alarm (1–8, default 4). */
  pageConcurrency?: number;
  /** OCR cells per language the job spreads its images over (1–8, default 2). */
  ocrCells?: number;
};

type JobState = {
  status: JobStatus;
  name: string;
  size: number;
  options: JobOptions;
  pageCount: number;
  /** The lowest page not done or failed yet (1-based). */
  nextPage: number;
  /** Tesseract code of the document's language, once known. */
  language?: string;
  /** Failed attempts per page not done yet. */
  attempts: Record<string, number>;
  failedPages: { page: number; error: string }[];
  /** How much of the PDF pdf.js has read from SQLite, over all alarms. */
  reads: { bytesRead: number; requests: number; opens: number };
  alarms: number;
  createdAt: string;
  finishedAt?: string;
  error?: string;
};

export type JobView = Omit<JobState, "attempts"> & { pagesDone: number };

type StoredPage = { page: PageInfo; blocks: PortableTextBlock[]; assets: string[] };

/** Attempts per page before it is recorded as failed. */
const MAX_ATTEMPTS = 3;
/** pdf.js allocates the file's size once (see above): keep it well inside 128 MB. */
export const MAX_JOB_PDF_BYTES = 64 * 1024 * 1024;
/** An upload that is never started is removed after this long. */
const ABANDONED_UPLOAD_MS = 60 * 60 * 1000;

const clamp = (n: number | undefined, fallback: number) =>
  Math.min(8, Math.max(1, Math.floor(n ?? fallback) || fallback));

export class PdfJob extends DurableObject<Env> {
  readonly #sql: Sql;
  readonly #blobs: BlobStore;
  #pdf: Promise<{ pdf: PDFDocumentProxy; stats: RangeStats }> | undefined;
  /** The part of the open document's read stats already added to the state. */
  #counted = { bytesRead: 0, requests: 0 };
  #ocrTurn = 0;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#sql = ctx.storage.sql as unknown as Sql;
    this.#blobs = new BlobStore(this.#sql);
    this.#createTables();
  }

  /** The job's tables (again after `destroy`, which drops them under this live instance). */
  #createTables(): void {
    this.#blobs.createTables();
    this.#sql.exec(
      "CREATE TABLE IF NOT EXISTS job (id INTEGER PRIMARY KEY CHECK (id = 1), state TEXT NOT NULL)",
    );
    this.#sql.exec("CREATE TABLE IF NOT EXISTS page (n INTEGER PRIMARY KEY, ok INTEGER NOT NULL)");
    this.#sql.exec("CREATE TABLE IF NOT EXISTS asset (id TEXT PRIMARY KEY, meta TEXT NOT NULL)");
  }

  #state(): JobState | null {
    const row = this.#sql.exec("SELECT state FROM job WHERE id = 1").toArray()[0];
    return row ? (JSON.parse(String(row.state)) as JobState) : null;
  }

  #save(state: JobState): void {
    this.#sql.exec("INSERT OR REPLACE INTO job (id, state) VALUES (1, ?)", JSON.stringify(state));
  }

  #view(state: JobState): JobView {
    const { attempts: _attempts, ...rest } = state;
    const pagesDone = Number(this.#sql.exec("SELECT COUNT(*) AS n FROM page").toArray()[0].n);
    return { ...rest, pagesDone };
  }

  /**
   * Adds a part of the PDF (a multiple of 1 MiB, except the last). Returns the bytes received.
   * An upload that is never started is removed after an hour.
   */
  async append(part: Uint8Array): Promise<number> {
    if (this.#state()) throw new Error("EEXIST: this job has already been started");
    const before = this.#blobs.size("pdf") ?? 0;
    if (before + part.byteLength > MAX_JOB_PDF_BYTES)
      throw new Error(`E2BIG: a job takes PDFs of at most ${MAX_JOB_PDF_BYTES >> 20} MB`);
    if (part.byteLength % BLOB_CHUNK !== 0 && before % BLOB_CHUNK !== 0)
      throw new Error("EINVAL: only the last part may be shorter than 1 MiB");
    const size = this.#blobs.append("pdf", part);
    if (before === 0) await this.ctx.storage.setAlarm(Date.now() + ABANDONED_UPLOAD_MS);
    return size;
  }

  /** Checks the uploaded PDF and schedules the first batch. A job starts once. */
  async start(name: string, options: JobOptions): Promise<JobView> {
    if (this.#state()) throw new Error("EEXIST: this job has already been started");
    const size = this.#blobs.size("pdf") ?? 0;
    if (size === 0) throw new Error("EINVAL: send a PDF");
    if (new TextDecoder().decode(this.#blobs.read("pdf", 0, 5)) !== "%PDF-")
      throw new Error("EINVAL: not a PDF");
    if (options.lang !== "auto" && !languageByTesseract(options.lang))
      throw new Error(`EINVAL: unsupported language '${options.lang}'`);
    const state: JobState = {
      status: "queued",
      name,
      size,
      options: {
        ...options,
        pageConcurrency: clamp(options.pageConcurrency, 4),
        ocrCells: clamp(options.ocrCells, 2),
      },
      pageCount: 0,
      nextPage: 1,
      attempts: {},
      failedPages: [],
      reads: { bytesRead: 0, requests: 0, opens: 0 },
      alarms: 0,
      createdAt: new Date().toISOString(),
    };
    this.#save(state);
    await this.ctx.storage.setAlarm(Date.now());
    return this.#view(state);
  }

  async status(): Promise<JobView | null> {
    const state = this.#state();
    return state ? this.#view(state) : null;
  }

  async page(n: number): Promise<StoredPage | null> {
    return this.#blobs.getJson<StoredPage>(`page:${n}`);
  }

  async asset(id: string): Promise<Uint8Array | null> {
    return this.#blobs.get(`asset:${id}`);
  }

  /** The PortableText document of the pages done so far (all of them once the job is done). */
  async document() {
    const state = this.#state();
    if (!state) return null;
    const pages: PageInfo[] = [];
    const blocks: PortableTextBlock[] = [];
    for (const row of this.#sql.exec("SELECT n FROM page WHERE ok = 1 ORDER BY n").toArray()) {
      const stored = this.#blobs.getJson<StoredPage>(`page:${row.n}`);
      if (!stored) continue;
      pages.push(stored.page);
      blocks.push(...stored.blocks);
    }
    const assets: Record<string, ImageAsset> = {};
    for (const row of this.#sql.exec("SELECT id, meta FROM asset").toArray())
      assets[String(row.id)] = JSON.parse(String(row.meta));
    const language = languageByTesseract(state.language ?? "eng") as Language;
    return {
      status: state.status,
      complete: state.status === "done",
      document: assembleDocument(state.name, state.size, language, pages, blocks, assets),
    };
  }

  async cancel(): Promise<JobView | null> {
    const state = this.#state();
    if (!state) return null;
    if (state.status === "queued" || state.status === "running") {
      state.status = "cancelled";
      state.finishedAt = new Date().toISOString();
      this.#save(state);
      await this.ctx.storage.deleteAlarm();
      await this.#closePdf();
    }
    return this.#view(state);
  }

  /** Removes everything the job stored. */
  async destroy(): Promise<void> {
    await this.#closePdf();
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    this.#createTables();
  }

  #openPdf(): Promise<{ pdf: PDFDocumentProxy; stats: RangeStats }> {
    if (!this.#pdf) {
      const size = this.#blobs.size("pdf");
      this.#counted = { bytesRead: 0, requests: 0 };
      this.#pdf =
        size === null
          ? Promise.reject(new Error("ENOENT: the job's PDF is missing"))
          : openPdfRanges(size, (begin, end) => this.#blobs.read("pdf", begin, end));
      this.#pdf.catch(() => {
        this.#pdf = undefined;
      });
    }
    return this.#pdf;
  }

  async #closePdf(): Promise<void> {
    const opened = this.#pdf;
    this.#pdf = undefined;
    if (opened) await (await opened.catch(() => null))?.pdf.loadingTask.destroy();
  }

  /** Adds what pdf.js read since the last count to the state's totals. */
  #countReads(state: JobState, stats: RangeStats | undefined): void {
    if (!stats) return;
    state.reads.bytesRead += stats.bytesRead - this.#counted.bytesRead;
    state.reads.requests += stats.requests - this.#counted.requests;
    this.#counted = { bytesRead: stats.bytesRead, requests: stats.requests };
  }

  /** The cell for the next image: a round robin over the language's pool. */
  #ocrCell(lang: string, cells: number): string {
    const k = this.#ocrTurn++ % cells;
    return k === 0 ? `ocr-${lang}` : `ocr-${lang}-${k}`;
  }

  #isDone(n: number): boolean {
    return this.#sql.exec("SELECT 1 FROM page WHERE n = ?", n).toArray().length > 0;
  }

  /** Converts page `n` and commits it, unless the job was cancelled or removed meanwhile. */
  async #convertAndStore(pdf: PDFDocumentProxy, n: number, state: JobState): Promise<void> {
    const language = languageByTesseract(state.language ?? "eng") as Language;
    const { engine, ocrCells = 2 } = state.options;
    const ocr = (image: RawImage, lang: string) => {
      const cell = this.#ocrCell(lang, ocrCells);
      return this.env.OCR.get(this.env.OCR.idFromName(cell)).ocr(image, lang, { engine });
    };
    const known = (id: string) =>
      this.#sql.exec("SELECT 1 FROM asset WHERE id = ?", id).toArray().length > 0;
    const result = await convertPage(pdf, n, language, { lang: state.options.lang, ocr }, known);
    // The page and its new assets commit together.
    this.ctx.storage.transactionSync(() => {
      if (this.#state()?.status !== "running") return;
      for (const a of result.assets) {
        this.#blobs.put(`asset:${a.meta._id}`, a.png);
        this.#sql.exec(
          "INSERT OR REPLACE INTO asset (id, meta) VALUES (?, ?)",
          a.meta._id,
          JSON.stringify(a.meta),
        );
      }
      const stored: StoredPage = {
        page: result.page,
        blocks: result.blocks,
        assets: result.assets.map((a) => a.meta._id),
      };
      this.#blobs.putJson(`page:${n}`, stored);
      this.#sql.exec("INSERT OR REPLACE INTO page (n, ok) VALUES (?, 1)", n);
    });
  }

  async alarm(): Promise<void> {
    const state = this.#state();
    if (!state) {
      // An upload that was never started.
      await this.ctx.storage.deleteAll();
      this.#createTables();
      return;
    }
    if (state.status !== "queued" && state.status !== "running") return;
    state.alarms += 1;
    let opened: { pdf: PDFDocumentProxy; stats: RangeStats };
    try {
      const first = !this.#pdf;
      opened = await this.#openPdf();
      if (first) state.reads.opens += 1;
      if (state.status === "queued") {
        // First alarm: the page count and the language, then the pages.
        state.pageCount = Math.min(
          opened.pdf.numPages,
          state.options.maxPages ?? Number.POSITIVE_INFINITY,
        );
        state.language = (
          await documentLanguage(opened.pdf, {
            lang: state.options.lang,
            maxPages: state.pageCount,
          })
        ).tesseract;
        state.status = "running";
      }
      this.#countReads(state, opened.stats);
      this.#save(state);
    } catch (e) {
      // An unreadable PDF fails the job: there is nothing to retry.
      state.status = "failed";
      state.error = String((e as Error)?.message ?? e);
      state.finishedAt = new Date().toISOString();
      this.#save(state);
      await this.#closePdf();
      return;
    }

    // The batch: the next pages not done or failed yet.
    const failed = new Set(state.failedPages.map((f) => f.page));
    const batch: number[] = [];
    for (
      let n = state.nextPage;
      n <= state.pageCount && batch.length < (state.options.pageConcurrency ?? 4);
      n++
    ) {
      if (!failed.has(n) && !this.#isDone(n)) batch.push(n);
    }
    const outcomes = await Promise.allSettled(
      batch.map((n) => this.#convertAndStore(opened.pdf, n, state)),
    );

    // Cancelled or removed while the batch ran: nothing more to do.
    const now = this.#state();
    if (now?.status !== "running") return;
    now.alarms = state.alarms;
    now.reads = state.reads;
    this.#countReads(now, opened.stats);
    let retry = 0;
    outcomes.forEach((outcome, i) => {
      if (outcome.status === "fulfilled") return;
      const n = batch[i];
      const attempts = (now.attempts[n] ?? 0) + 1;
      if (attempts < MAX_ATTEMPTS) {
        now.attempts[n] = attempts;
        retry = Math.max(retry, attempts);
      } else {
        delete now.attempts[n];
        now.failedPages.push({ page: n, error: String(outcome.reason?.message ?? outcome.reason) });
      }
    });
    for (const n of batch) if (this.#isDone(n)) delete now.attempts[n];
    const settled = new Set(now.failedPages.map((f) => f.page));
    while (
      now.nextPage <= now.pageCount &&
      (settled.has(now.nextPage) || this.#isDone(now.nextPage))
    )
      now.nextPage += 1;

    if (now.nextPage > now.pageCount) {
      now.status = "done";
      now.finishedAt = new Date().toISOString();
      this.#save(now);
      await this.#closePdf();
      return;
    }
    this.#save(now);
    const delay = retry > 0 ? 1000 * 2 ** retry : (now.options.throttleMs ?? 0);
    await this.ctx.storage.setAlarm(Date.now() + delay);
  }
}
