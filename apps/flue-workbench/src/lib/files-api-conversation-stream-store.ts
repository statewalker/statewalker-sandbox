import {
  type AgentSubmissionStore,
  type ConversationFoldCheckpoint,
  type ConversationProducerClaim,
  type ConversationRecord,
  type ConversationStreamIdentity,
  type ConversationStreamMeta,
  type ConversationStreamReadResult,
  type ConversationStreamStore,
  ConversationStreamStoreError,
  clampLimit,
  DEFAULT_READ_LIMIT,
  formatOffset,
  MAX_READ_LIMIT,
  parseOffset,
  parseSessionStorageKey,
  StreamListenerRegistry,
} from "@flue/runtime/adapter";
import type { FilesApi } from "@statewalker/webrun-files";
import { encodeSegment, listNames, readJson, WriteQueue, writeJson } from "./files-api-json.js";

/** `<streamDir>/stream.json` — identity plus producer fence state. */
export interface StreamHeader {
  identity: ConversationStreamIdentity;
  incarnation: string;
  producerId: string | null;
  producerEpoch: number;
  nextProducerSequence: number;
}

/** `<streamDir>/batches/<seq>.json` — one append-only canonical batch. */
interface StoredBatch {
  offset: string;
  producerId: string;
  producerEpoch: number;
  producerSequence: number;
  /** The serialized records, kept verbatim so retries compare byte-exact. */
  data: string;
  submissionId: string | null;
  attemptId: string | null;
}

interface StreamState extends StreamHeader {
  batches: StoredBatch[];
}

function batchFileName(seq: number): string {
  return `${String(seq).padStart(12, "0")}.json`;
}

/**
 * Flue 2 `ConversationStreamStore` over a `FilesApi` directory — the
 * canonical, append-only transcript of each agent instance (what Flue 0.7
 * kept as a whole `SessionData` blob).
 *
 * Layout under `dir`, one directory per stream (hex-encoded stream path so
 * the slashes in `agents/<agent>/<instance>` never nest):
 *
 *     <hex(path)>/stream.json            identity, incarnation, producer fence
 *     <hex(path)>/batches/<seq>.json     one file per appended batch
 *     <hex(path)>/checkpoint.json        optional fold checkpoint (a cache)
 *
 * Streams load lazily on first touch and then live in memory; every fence
 * check and state change runs synchronously on that in-memory state (the
 * single-runtime-per-tab model makes that the atomicity boundary), and the
 * files are written before the call resolves. A batch file is written
 * before the header that counts it, and loading stops at the first
 * missing/unreadable batch, so a torn write loses at most the batch that
 * was being appended — never the stream.
 *
 * Fence semantics are a port of Flue's `InMemoryConversationStreamStore`
 * reference; the contract suite from `@flue/runtime/test-utils` verifies them.
 */
export class FilesApiConversationStreamStore implements ConversationStreamStore {
  private readonly files: FilesApi;
  private readonly dir: string;
  private readonly submissionStore: AgentSubmissionStore | undefined;
  private readonly streams = new Map<string, StreamState | null>();
  private readonly loading = new Map<string, Promise<void>>();
  private readonly listeners = new StreamListenerRegistry();
  private readonly writes = new WriteQueue();
  private appendChain: Promise<unknown> = Promise.resolve();

  constructor(opts: { files: FilesApi; dir: string; submissionStore?: AgentSubmissionStore }) {
    this.files = opts.files;
    this.dir = opts.dir;
    this.submissionStore = opts.submissionStore;
  }

  /** Resolves once every pending file write has reached the FilesApi. */
  flush(): Promise<void> {
    return this.writes.drain();
  }

  async createStream(path: string, identity: ConversationStreamIdentity): Promise<void> {
    await this.load(path);
    // Re-read synchronously after the await: a racing create may have
    // installed the stream between our load and this continuation.
    const existing = this.streams.get(path);
    if (existing) {
      if (
        existing.identity.agentName !== identity.agentName ||
        existing.identity.instanceId !== identity.instanceId
      ) {
        this.fail("create", path, "Stream identity conflicts.");
      }
      return;
    }
    const state: StreamState = {
      identity: { agentName: identity.agentName, instanceId: identity.instanceId },
      incarnation: crypto.randomUUID(),
      producerId: null,
      producerEpoch: 0,
      nextProducerSequence: 0,
      batches: [],
    };
    this.streams.set(path, state);
    await this.writeHeader(path, state);
  }

  async acquireProducer(path: string, producerId: string): Promise<ConversationProducerClaim> {
    const stream = await this.load(path);
    if (!stream) this.fail("acquire_producer", path, "Stream does not exist.");
    stream.producerId = producerId;
    stream.producerEpoch += 1;
    stream.nextProducerSequence = 0;
    const claim: ConversationProducerClaim = {
      producerId,
      producerEpoch: stream.producerEpoch,
      incarnation: stream.incarnation,
      nextProducerSequence: 0,
      offset: formatOffset(stream.batches.length - 1),
    };
    await this.writeHeader(path, stream);
    return claim;
  }

  append(input: {
    path: string;
    producerId: string;
    producerEpoch: number;
    incarnation: string;
    producerSequence: number;
    submission?: { submissionId: string; attemptId: string };
    records: readonly ConversationRecord[];
  }): Promise<{ offset: string }> {
    // Appends serialize: the authorization check awaits the submission
    // store, and two appends must not both pass the sequence check first.
    const result = this.appendChain.then(() => this.appendSerialized(input));
    this.appendChain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async read(
    path: string,
    options?: { offset?: string; limit?: number },
  ): Promise<ConversationStreamReadResult> {
    const stream = await this.load(path);
    if (!stream) return { batches: [], nextOffset: "-1", upToDate: true };
    const head = stream.batches.length - 1;
    const rawOffset = options?.offset ?? "-1";
    if (rawOffset === "now") return { batches: [], nextOffset: formatOffset(head), upToDate: true };
    const startAfter = parseOffset(rawOffset);
    if (!Number.isSafeInteger(startAfter) || startAfter > head) {
      this.fail("read", path, "Read offset is beyond the canonical stream head.");
    }
    const limit = clampLimit(options?.limit, DEFAULT_READ_LIMIT, MAX_READ_LIMIT);
    const page = stream.batches.slice(startAfter + 1, startAfter + 1 + limit);
    return {
      batches: page.map((batch) => ({
        offset: batch.offset,
        records: JSON.parse(batch.data) as ConversationRecord[],
      })),
      nextOffset: page.at(-1)?.offset ?? formatOffset(startAfter),
      upToDate: startAfter + page.length >= head,
    };
  }

  async getMeta(path: string): Promise<ConversationStreamMeta | null> {
    const stream = await this.load(path);
    if (!stream) return null;
    return {
      identity: { ...stream.identity },
      incarnation: stream.incarnation,
      nextOffset: formatOffset(stream.batches.length - 1),
      producerId: stream.producerId,
      producerEpoch: stream.producerEpoch,
      nextProducerSequence: stream.nextProducerSequence,
    };
  }

  subscribe(path: string, listener: () => void): () => void {
    return this.listeners.subscribe(path, listener);
  }

  async putFoldCheckpoint(path: string, checkpoint: ConversationFoldCheckpoint): Promise<void> {
    const snapshot = { ...checkpoint };
    await this.writes.run(() =>
      writeJson(this.files, `${this.streamDir(path)}/checkpoint.json`, snapshot),
    );
  }

  async getFoldCheckpoint(
    path: string,
    options?: { atOrBefore?: string },
  ): Promise<ConversationFoldCheckpoint | null> {
    await this.writes.drain();
    const result = await readJson<ConversationFoldCheckpoint>(
      this.files,
      `${this.streamDir(path)}/checkpoint.json`,
    );
    // A torn checkpoint must read back as absent: the runtime then rebuilds
    // by replaying the stream, which is always authoritative.
    if (result.kind !== "ok" || typeof result.value?.offset !== "string") return null;
    const checkpoint = result.value;
    if (
      options?.atOrBefore !== undefined &&
      parseOffset(checkpoint.offset) > parseOffset(options.atOrBefore)
    ) {
      return null;
    }
    return checkpoint;
  }

  // ── Internals ───────────────────────────────────────────────────────

  private async appendSerialized(input: {
    path: string;
    producerId: string;
    producerEpoch: number;
    incarnation: string;
    producerSequence: number;
    submission?: { submissionId: string; attemptId: string };
    records: readonly ConversationRecord[];
  }): Promise<{ offset: string }> {
    if (input.records.length === 0) {
      this.fail("append", input.path, "A canonical batch cannot be empty.");
    }
    const data = JSON.stringify(input.records);
    const stream = await this.load(input.path);
    if (!stream) this.fail("append", input.path, "Stream does not exist.");
    if (
      stream.producerId !== input.producerId ||
      stream.producerEpoch !== input.producerEpoch ||
      stream.incarnation !== input.incarnation
    ) {
      this.fail("append", input.path, "Producer ownership is stale.");
    }
    const submissionId = input.submission?.submissionId ?? null;
    const attemptId = input.submission?.attemptId ?? null;
    const retry = stream.batches.find(
      (batch) =>
        batch.producerId === input.producerId &&
        batch.producerEpoch === input.producerEpoch &&
        batch.producerSequence === input.producerSequence,
    );
    if (retry) {
      if (
        retry.data !== data ||
        retry.submissionId !== submissionId ||
        retry.attemptId !== attemptId
      ) {
        this.fail("append", input.path, "Producer sequence has conflicting content.");
      }
      return { offset: retry.offset };
    }
    if (stream.nextProducerSequence !== input.producerSequence) {
      this.fail("append", input.path, "Producer sequence is not the next expected value.");
    }
    await this.assertSubmissionAuthorization(input.path, stream, input.submission, input.records);

    const seq = stream.batches.length;
    const batch: StoredBatch = {
      offset: formatOffset(seq),
      producerId: input.producerId,
      producerEpoch: input.producerEpoch,
      producerSequence: input.producerSequence,
      data,
      submissionId,
      attemptId,
    };
    stream.batches.push(batch);
    stream.nextProducerSequence += 1;
    const header = toHeader(stream);
    const dir = this.streamDir(input.path);
    // Batch first, header second: a crash in between leaves a header that
    // under-counts the producer sequence, which `load()` repairs from the
    // batches themselves.
    await this.writes.run(async () => {
      await writeJson(this.files, `${dir}/batches/${batchFileName(seq)}`, batch);
      await writeJson(this.files, `${dir}/stream.json`, header);
    });
    this.listeners.notify(input.path);
    return { offset: batch.offset };
  }

  /**
   * Submission-owned records may only be appended by the attempt that owns
   * the submission (or a turn-boundary join absorbed into it), and only
   * into the stream of the same agent instance.
   */
  private async assertSubmissionAuthorization(
    path: string,
    stream: StreamState,
    submission: { submissionId: string; attemptId: string } | undefined,
    records: readonly ConversationRecord[],
  ): Promise<void> {
    const owned = records.filter(
      (record) => record.submissionId !== undefined || record.attemptId !== undefined,
    );
    if (!submission) {
      if (owned.length > 0) {
        this.fail("append", path, "Submission-owned records require an attempt authorization.");
      }
      return;
    }
    for (const record of owned) {
      if (
        record.submissionId === submission.submissionId &&
        record.attemptId === submission.attemptId
      ) {
        continue;
      }
      if (
        this.submissionStore &&
        record.attemptId === submission.attemptId &&
        record.submissionId !== undefined
      ) {
        const delivery = await this.submissionStore.getSubmission(record.submissionId);
        if (
          (delivery?.status === "joining" || delivery?.status === "joined") &&
          delivery.joinedInto === submission.submissionId
        ) {
          continue;
        }
      }
      this.fail(
        "append",
        path,
        "Record ownership does not match the authorized submission attempt.",
      );
    }
    if (!this.submissionStore) return;

    const row = await this.submissionStore.getSubmission(submission.submissionId);
    const sessionIdentity = row ? parseSessionStorageKey(row.sessionKey) : undefined;
    const obligation = (await this.submissionStore.listPendingSubmissionSettlements()).find(
      (pending) => pending.submissionId === submission.submissionId,
    );
    const first = owned[0];
    const terminalizingSettlement =
      row?.status === "terminalizing" &&
      records.length === 1 &&
      owned.length === 1 &&
      first?.type === "submission_settled" &&
      obligation?.recordId === first.id &&
      JSON.stringify(obligation.record) === JSON.stringify(first);
    if (
      !row ||
      (row.status !== "running" && !terminalizingSettlement) ||
      row.attemptId !== submission.attemptId ||
      !sessionIdentity ||
      sessionIdentity.agentName !== stream.identity.agentName ||
      sessionIdentity.instanceId !== stream.identity.instanceId
    ) {
      this.fail("append", path, "Submission attempt no longer owns work for this agent instance.");
    }
  }

  private streamDir(path: string): string {
    return `${this.dir}/${encodeSegment(path)}`;
  }

  private writeHeader(path: string, stream: StreamState): Promise<void> {
    const header = toHeader(stream);
    return this.writes.run(() =>
      writeJson(this.files, `${this.streamDir(path)}/stream.json`, header),
    );
  }

  /** Load a stream into memory once; `null` caches "does not exist". */
  private async load(path: string): Promise<StreamState | null> {
    if (!this.streams.has(path)) {
      let pending = this.loading.get(path);
      if (!pending) {
        pending = this.readStream(path).then((state) => {
          // A concurrent createStream may have won while we were reading.
          if (!this.streams.has(path)) this.streams.set(path, state);
          this.loading.delete(path);
        });
        this.loading.set(path, pending);
      }
      await pending;
    }
    return this.streams.get(path) ?? null;
  }

  private async readStream(path: string): Promise<StreamState | null> {
    const dir = this.streamDir(path);
    const header = await readJson<StreamHeader>(this.files, `${dir}/stream.json`);
    if (header.kind === "missing") return null;
    if (header.kind === "corrupt" || typeof header.value?.incarnation !== "string") {
      // The fence state is unrecoverable; refusing loudly beats silently
      // forking the transcript under a new incarnation.
      this.fail("load", path, "Stream header is unreadable.");
    }
    const state: StreamState = { ...header.value, batches: [] };
    const names = await listNames(this.files, `${dir}/batches`, "file");
    for (let seq = 0; seq < names.length; seq++) {
      if (names[seq] !== batchFileName(seq)) break;
      const batch = await readJson<StoredBatch>(this.files, `${dir}/batches/${batchFileName(seq)}`);
      if (batch.kind !== "ok" || typeof batch.value?.data !== "string") {
        console.warn(`[flue-workbench] stream ${path}: truncating at unreadable batch ${seq}`);
        break;
      }
      state.batches.push(batch.value);
    }
    // Repair a header written before its batch landed (or vice versa).
    for (const batch of state.batches) {
      if (batch.producerId === state.producerId && batch.producerEpoch === state.producerEpoch) {
        state.nextProducerSequence = Math.max(
          state.nextProducerSequence,
          batch.producerSequence + 1,
        );
      }
    }
    return state;
  }

  private fail(operation: string, path: string, reason: string): never {
    throw new ConversationStreamStoreError({ operation, path, reason });
  }
}

function toHeader(stream: StreamState): StreamHeader {
  return {
    identity: { ...stream.identity },
    incarnation: stream.incarnation,
    producerId: stream.producerId,
    producerEpoch: stream.producerEpoch,
    nextProducerSequence: stream.nextProducerSequence,
  };
}
