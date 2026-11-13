/**
 * One PDF conversion as a Durable Object. `start` stores the PDF in the job's SQLite and sets
 * an alarm; every alarm converts **one page** and sets the next. Each alarm is an invocation
 * of its own, with its own CPU budget (30 s by default, up to 5 min), so a document of any
 * length is not bound by one request; the OCR of a page's images runs in the language's
 * OcrCell, outside this job's budget.
 *
 * Progress, pages and PNG assets are in SQLite as they are done, so the job resumes where it
 * was after an eviction or a restart (the alarm is durable too). A page that fails is retried
 * with a growing delay, then recorded as failed and skipped. The pdf.js document is kept in
 * memory between alarms while the isolate lives, and opened again from SQLite when it does not.
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
import { BlobStore } from "../blob-store.ts";
import type { RawImage } from "../decode.ts";
import type { Sql } from "../models.ts";
import type { Env } from "../ocr-cell.ts";
import { assembleDocument, convertPage, documentLanguage } from "./convert.ts";
import { openPdf } from "./pdfjs.ts";

export type JobStatus = "queued" | "running" | "done" | "failed" | "cancelled";

export type JobOptions = {
  /** Tesseract language, or `auto`. */
  lang: string;
  engine: "cell" | "isolate";
  maxPages?: number;
  /** Pause between pages (ms): spreads the OCR load; tests use it to stop a job half-way. */
  throttleMs?: number;
};

type JobState = {
  status: JobStatus;
  name: string;
  size: number;
  options: JobOptions;
  pageCount: number;
  /** The next page to convert (1-based). */
  nextPage: number;
  /** Tesseract code of the document's language, once known. */
  language?: string;
  /** Failed attempts of `nextPage` so far. */
  attempts: number;
  failedPages: { page: number; error: string }[];
  createdAt: string;
  finishedAt?: string;
  error?: string;
};

export type JobView = Omit<JobState, "options" | "attempts"> & {
  pagesDone: number;
  options: JobOptions;
};

type StoredPage = { page: PageInfo; blocks: PortableTextBlock[]; assets: string[] };

/** Attempts per page before it is recorded as failed. */
const MAX_ATTEMPTS = 3;
const MAX_PDF_BYTES = 20 * 1024 * 1024;

export class PdfJob extends DurableObject<Env> {
  readonly #sql: Sql;
  readonly #blobs: BlobStore;
  #pdf: Promise<PDFDocumentProxy> | undefined;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#sql = ctx.storage.sql as unknown as Sql;
    this.#blobs = new BlobStore(this.#sql);
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

  /** Stores the PDF and schedules the first page. A job starts once. */
  async start(pdf: Uint8Array, name: string, options: JobOptions): Promise<JobView> {
    if (this.#state()) throw new Error("EEXIST: this job has already been started");
    if (pdf.byteLength === 0 || pdf.byteLength > MAX_PDF_BYTES)
      throw new Error("EINVAL: send a PDF (at most 20 MB)");
    if (options.lang !== "auto" && !languageByTesseract(options.lang))
      throw new Error(`EINVAL: unsupported language '${options.lang}'`);
    const state: JobState = {
      status: "queued",
      name,
      size: pdf.byteLength,
      options,
      pageCount: 0,
      nextPage: 1,
      attempts: 0,
      failedPages: [],
      createdAt: new Date().toISOString(),
    };
    this.ctx.storage.transactionSync(() => {
      this.#blobs.put("pdf", pdf);
      this.#save(state);
    });
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
  }

  #openPdf(): Promise<PDFDocumentProxy> {
    this.#pdf ??= (async () => {
      const bytes = this.#blobs.get("pdf");
      if (!bytes) throw new Error("ENOENT: the job's PDF is missing");
      return openPdf(bytes);
    })();
    this.#pdf.catch(() => {
      this.#pdf = undefined;
    });
    return this.#pdf;
  }

  async #closePdf(): Promise<void> {
    const pdf = this.#pdf;
    this.#pdf = undefined;
    if (pdf) await (await pdf.catch(() => null))?.loadingTask.destroy();
  }

  /** One page per alarm. */
  async alarm(): Promise<void> {
    const state = this.#state();
    if (!state || (state.status !== "queued" && state.status !== "running")) return;
    let pdf: PDFDocumentProxy;
    try {
      pdf = await this.#openPdf();
      if (state.status === "queued") {
        // First alarm: the page count and the language, then the pages.
        state.pageCount = Math.min(
          pdf.numPages,
          state.options.maxPages ?? Number.POSITIVE_INFINITY,
        );
        state.language = (
          await documentLanguage(pdf, { lang: state.options.lang, maxPages: state.pageCount })
        ).tesseract;
        state.status = "running";
        this.#save(state);
      }
    } catch (e) {
      // An unreadable PDF fails the job: there is nothing to retry.
      state.status = "failed";
      state.error = String((e as Error)?.message ?? e);
      state.finishedAt = new Date().toISOString();
      this.#save(state);
      await this.#closePdf();
      return;
    }

    const n = state.nextPage;
    if (n <= state.pageCount) {
      const language = languageByTesseract(state.language ?? "eng") as Language;
      const { engine } = state.options;
      const ocr = (image: RawImage, lang: string) =>
        this.env.OCR.get(this.env.OCR.idFromName(`ocr-${lang}`)).ocr(image, lang, { engine });
      const known = (id: string) =>
        this.#sql.exec("SELECT 1 FROM asset WHERE id = ?", id).toArray().length > 0;
      try {
        const result = await convertPage(
          pdf,
          n,
          language,
          { lang: state.options.lang, ocr },
          known,
        );
        // The page, its new assets and the progress commit together.
        this.ctx.storage.transactionSync(() => {
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
          state.nextPage = n + 1;
          state.attempts = 0;
          this.#save(state);
        });
      } catch (e) {
        state.attempts += 1;
        if (state.attempts < MAX_ATTEMPTS) {
          this.#save(state);
          await this.ctx.storage.setAlarm(Date.now() + 1000 * 2 ** state.attempts);
          return;
        }
        state.failedPages.push({ page: n, error: String((e as Error)?.message ?? e) });
        state.nextPage = n + 1;
        state.attempts = 0;
        this.#save(state);
      }
    }

    if (state.nextPage > state.pageCount) {
      state.status = "done";
      state.finishedAt = new Date().toISOString();
      this.#save(state);
      await this.#closePdf();
      return;
    }
    await this.ctx.storage.setAlarm(Date.now() + (state.options.throttleMs ?? 0));
  }
}
