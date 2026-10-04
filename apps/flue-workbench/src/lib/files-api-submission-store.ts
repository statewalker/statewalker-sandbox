import {
  type AgentDispatchAdmission,
  type AgentSubmission,
  type AgentSubmissionInput,
  type AgentSubmissionStore,
  admitSubmissionWithBackend,
  createDispatchAgentSubmissionInput,
  type DispatchInput,
  DURABILITY_DEFAULT_MAX_ATTEMPTS,
  DURABILITY_DEFAULT_TIMEOUT_MS,
  hydratePersistedSubmissionAttachments,
  isSubmissionPayload,
  LEASE_DURATION_MS,
  type SubmissionAttemptRef,
  type SubmissionChunkRow,
  type SubmissionClaimRef,
  type SubmissionDurability,
  type SubmissionSettledRecord,
  type SubmissionSettlementObligation,
} from "@flue/runtime/adapter";
import type { FilesApi } from "@statewalker/webrun-files";
import { listNames, readJson, WriteQueue, writeJson } from "./files-api-json.js";

type SubmissionStatus = AgentSubmission["status"];

/**
 * One persisted submission: the same columns Flue's SQLite reference store
 * keeps in `flue_agent_submissions`, as a plain JSON object.
 */
export interface SubmissionRow {
  sequence: number;
  submissionId: string;
  sessionKey: string;
  kind: "dispatch" | "direct";
  payload: string;
  status: SubmissionStatus;
  acceptedAt: number;
  canonicalReadyAt: number | null;
  attemptId: string | null;
  inputAppliedAt: number | null;
  abortRequestedAt: number | null;
  startedAt: number | null;
  joinedInto: string | null;
  settledAt: number | null;
  error: string | null;
  attemptCount: number;
  maxAttempts: number;
  timeoutAt: number;
  ownerId: string | null;
  leaseExpiresAt: number;
  settlementRecordId: string | null;
  settlementRecord: string | null;
}

/** File content of `<dir>/<sequence>.json`. */
interface SubmissionFile {
  row: SubmissionRow;
  chunks: SubmissionChunkRow[];
}

const UNSETTLED: ReadonlySet<SubmissionStatus> = new Set([
  "queued",
  "running",
  "terminalizing",
  "joining",
  "joined",
]);

export function submissionFileName(sequence: number): string {
  return `${String(sequence).padStart(12, "0")}.json`;
}

/**
 * Load every persisted submission row under `dir`. Unparsable files (torn
 * write, hand edit) are skipped with a warning — losing one ledger row only
 * loses crash-recovery for that submission, never the transcript, which
 * lives in the conversation stream.
 */
export async function loadSubmissionFiles(files: FilesApi, dir: string): Promise<SubmissionFile[]> {
  const loaded: SubmissionFile[] = [];
  for (const name of await listNames(files, dir, "file")) {
    if (!name.endsWith(".json")) continue;
    const result = await readJson<SubmissionFile>(files, `${dir}/${name}`);
    if (result.kind !== "ok" || typeof result.value?.row?.submissionId !== "string") {
      console.warn(`[flue-workbench] skipping unreadable submission file ${dir}/${name}`);
      continue;
    }
    loaded.push(result.value);
  }
  return loaded.sort((a, b) => a.row.sequence - b.row.sequence);
}

/**
 * Flue 2 `AgentSubmissionStore` over a `FilesApi` directory.
 *
 * The durable submission ledger is small (one row per prompt) and the
 * workbench runs a single runtime per tab, so the store keeps every row in
 * memory and writes each touched row back to `<dir>/<sequence>.json` before
 * the mutating call resolves. All checks and state transitions happen
 * synchronously on the in-memory rows — that is what gives the contract's
 * "observable atomicity" (two concurrent claims can never both succeed)
 * without transactions: JavaScript never interleaves two synchronous blocks.
 *
 * The method semantics are a line-by-line port of Flue's SQLite reference
 * store (`createSqlAgentExecutionStoreFromSql`); the contract suite from
 * `@flue/runtime/test-utils` verifies them.
 */
export class FilesApiSubmissionStore implements AgentSubmissionStore {
  private readonly files: FilesApi;
  private readonly dir: string;
  private readonly rows = new Map<string, SubmissionRow>();
  private readonly chunks = new Map<string, SubmissionChunkRow[]>();
  private readonly writes = new WriteQueue();
  private nextSequence = 1;

  private constructor(files: FilesApi, dir: string) {
    this.files = files;
    this.dir = dir;
  }

  /** Open the store, loading every persisted row from `dir`. */
  static async open(files: FilesApi, dir: string): Promise<FilesApiSubmissionStore> {
    const store = new FilesApiSubmissionStore(files, dir);
    for (const { row, chunks } of await loadSubmissionFiles(files, dir)) {
      store.rows.set(row.submissionId, row);
      store.chunks.set(row.submissionId, chunks ?? []);
      store.nextSequence = Math.max(store.nextSequence, row.sequence + 1);
    }
    return store;
  }

  /** Resolves once every pending row write has reached the FilesApi. */
  flush(): Promise<void> {
    return this.writes.drain();
  }

  // ── Query ───────────────────────────────────────────────────────────

  async getSubmission(submissionId: string): Promise<AgentSubmission | null> {
    const row = this.rows.get(submissionId);
    return row ? this.parse(row) : null;
  }

  async hasUnsettledSubmissions(): Promise<boolean> {
    for (const row of this.rows.values()) if (UNSETTLED.has(row.status)) return true;
    return false;
  }

  async listUnreadySubmissions(): Promise<AgentSubmission[]> {
    return this.parseOperational(
      this.ordered().filter((r) => r.status === "queued" && r.canonicalReadyAt === null),
      "queued",
    );
  }

  async listRunnableSubmissions(): Promise<AgentSubmission[]> {
    return this.parseOperational(
      this.ordered().filter((r) => this.isRunnableHead(r)),
      "queued",
    );
  }

  async listRunningSubmissions(): Promise<AgentSubmission[]> {
    return this.parseOperational(
      this.ordered().filter((r) => r.status === "running"),
      "active",
    );
  }

  async listPendingSubmissionSettlements(): Promise<SubmissionSettlementObligation[]> {
    return this.ordered()
      .filter((r) => r.status === "terminalizing")
      .map(toObligation);
  }

  async listExpiredSubmissions(): Promise<AgentSubmission[]> {
    const now = Date.now();
    return this.parseOperational(
      this.ordered().filter(
        (r) => r.status === "running" && r.leaseExpiresAt > 0 && r.leaseExpiresAt < now,
      ),
      "active",
    );
  }

  async listJoinedSubmissions(hostSubmissionId: string): Promise<AgentSubmission[]> {
    return this.parseOperational(
      this.ordered().filter(
        (r) =>
          r.joinedInto === hostSubmissionId && (r.status === "joining" || r.status === "joined"),
      ),
      "active",
    );
  }

  // ── Admission ───────────────────────────────────────────────────────

  async admitDispatch(input: DispatchInput): Promise<AgentDispatchAdmission> {
    return this.admit(createDispatchAgentSubmissionInput(input));
  }

  async admitDirect(input: AgentSubmissionInput): Promise<AgentSubmission> {
    const admission = await this.admit(input);
    if (admission.kind !== "submission") {
      throw new Error("[flue-workbench] Direct admission returned an unexpected result.");
    }
    return admission.submission;
  }

  async markSubmissionCanonicalReady(submissionId: string): Promise<AgentSubmission | null> {
    const row = this.rows.get(submissionId);
    if (row?.status !== "queued") return null;
    row.canonicalReadyAt ??= Date.now();
    await this.persist(row);
    return this.parse(row);
  }

  // ── Lifecycle ───────────────────────────────────────────────────────

  async replaceSubmissionAttempt(
    attempt: SubmissionAttemptRef,
    nextAttemptId: string,
    lease?: { ownerId: string; leaseExpiresAt: number },
  ): Promise<AgentSubmission | null> {
    const row = this.ownedRunning(attempt);
    if (!row) return null;
    row.attemptId = nextAttemptId;
    row.startedAt = Date.now();
    row.attemptCount += 1;
    if (lease) {
      row.ownerId = lease.ownerId;
      row.leaseExpiresAt = lease.leaseExpiresAt;
    }
    await this.persist(row);
    return this.parse(row);
  }

  async claimSubmission(claim: SubmissionClaimRef): Promise<AgentSubmission | null> {
    const row = this.rows.get(claim.submissionId);
    if (!row || !this.isRunnableHead(row)) return null;
    const now = Date.now();
    row.status = "running";
    row.attemptId = claim.attemptId;
    row.startedAt = now;
    row.attemptCount += 1;
    // Mirrors the reference store: the claim installs the default budget;
    // `markSubmissionInputApplied` replaces it with the agent's own policy.
    row.maxAttempts = DURABILITY_DEFAULT_MAX_ATTEMPTS;
    if (row.timeoutAt === 0) row.timeoutAt = now + DURABILITY_DEFAULT_TIMEOUT_MS;
    row.ownerId = claim.ownerId;
    row.leaseExpiresAt = claim.leaseExpiresAt;
    await this.persist(row);
    return this.parse(row);
  }

  async markSubmissionInputApplied(
    attempt: SubmissionAttemptRef,
    durability?: SubmissionDurability,
  ): Promise<boolean> {
    const row = this.ownedRunning(attempt);
    if (!row) return false;
    if (row.inputAppliedAt === null) {
      const now = Date.now();
      row.inputAppliedAt = now;
      row.maxAttempts = durability?.maxAttempts ?? DURABILITY_DEFAULT_MAX_ATTEMPTS;
      row.timeoutAt = durability?.timeoutAt ?? now + DURABILITY_DEFAULT_TIMEOUT_MS;
    }
    await this.persist(row);
    return true;
  }

  async requestSessionAbort(sessionKey: string): Promise<string[]> {
    const now = Date.now();
    const touched = this.ordered().filter(
      (r) =>
        r.sessionKey === sessionKey &&
        (r.status === "queued" ||
          r.status === "running" ||
          r.status === "joining" ||
          r.status === "joined"),
    );
    for (const row of touched) row.abortRequestedAt ??= now;
    await this.persist(...touched);
    return touched.map((r) => r.submissionId);
  }

  async requeueSubmission(attempt: SubmissionAttemptRef): Promise<boolean> {
    const row = this.ownedRunning(attempt);
    if (!row) return false;
    row.status = "queued";
    row.attemptId = null;
    row.inputAppliedAt = null;
    row.startedAt = null;
    row.ownerId = null;
    row.leaseExpiresAt = 0;
    await this.persist(row);
    return true;
  }

  async reserveSubmissionSettlement(
    attempt: SubmissionAttemptRef,
    settlement: { recordId: string; record: SubmissionSettledRecord },
  ): Promise<SubmissionSettlementObligation | null> {
    if (settlement.record.id !== settlement.recordId) return null;
    const recordJson = JSON.stringify(settlement.record);
    const row = this.rows.get(attempt.submissionId);
    if (!row) return null;

    const ownedRunning =
      row.status === "running" && row.attemptId === attempt.attemptId && row.ownerId !== null;
    const joinedToOwnedHost =
      row.status === "joined" && this.hostRunningUnder(row.joinedInto, attempt.attemptId);
    if (row.settlementRecordId === null && (ownedRunning || joinedToOwnedHost)) {
      row.status = "terminalizing";
      row.settlementRecordId = settlement.recordId;
      row.settlementRecord = recordJson;
      row.attemptId = attempt.attemptId;
      row.startedAt ??= Date.now();
      await this.persist(row);
      return toObligation(row);
    }

    // Exact retry of an already-reserved obligation.
    if (
      row.status === "terminalizing" &&
      row.attemptId === attempt.attemptId &&
      row.settlementRecordId === settlement.recordId &&
      row.settlementRecord === recordJson
    ) {
      return toObligation(row);
    }
    return null;
  }

  async finalizeSubmissionSettlement(
    attempt: SubmissionAttemptRef,
    recordId: string,
    options?: { errorMessage?: string },
  ): Promise<boolean> {
    const row = this.rows.get(attempt.submissionId);
    if (
      row?.status !== "terminalizing" ||
      row.attemptId !== attempt.attemptId ||
      row.settlementRecordId !== recordId ||
      row.settlementRecord === null
    ) {
      return false;
    }
    const record = JSON.parse(row.settlementRecord) as {
      outcome?: string;
      error?: { message?: string };
    };
    const errorMessage =
      record.outcome === "completed"
        ? null
        : (options?.errorMessage ?? record.error?.message ?? "The submission did not complete.");
    row.status = "settled";
    row.settledAt = Date.now();
    row.error = errorMessage;
    await this.persist(row, ...this.settleJoined(row.submissionId, errorMessage));
    return true;
  }

  async completeSubmission(attempt: SubmissionAttemptRef): Promise<boolean> {
    return this.settleOwned(attempt, null);
  }

  async failSubmission(attempt: SubmissionAttemptRef, error: unknown): Promise<boolean> {
    return this.settleOwned(attempt, error instanceof Error ? error.message : String(error));
  }

  async settleQueuedSubmission(
    submissionId: string,
    _outcome: "failed" | "aborted",
    error: unknown,
  ): Promise<boolean> {
    const row = this.rows.get(submissionId);
    if (row?.status !== "queued") return false;
    row.status = "settled";
    row.settledAt = Date.now();
    row.error = error instanceof Error ? error.message : String(error);
    await this.persist(row);
    return true;
  }

  // ── Turn-boundary joins ─────────────────────────────────────────────

  async claimJoinableSubmissions(
    host: SubmissionAttemptRef,
    agentName: string,
  ): Promise<AgentSubmission[]> {
    const hostRow = this.ownedRunning(host);
    if (!hostRow) return [];
    const claimed: AgentSubmission[] = [];
    const touched: SubmissionRow[] = [];
    for (const row of this.ordered()) {
      if (row.sessionKey !== hostRow.sessionKey || row.status !== "queued") continue;
      // Only the contiguous ready, un-aborted prefix of the queue may join.
      if (row.canonicalReadyAt === null || row.abortRequestedAt !== null) break;
      let submission: AgentSubmission;
      try {
        submission = this.parse(row);
      } catch {
        break;
      }
      if (submission.input.agent !== agentName) break;
      row.status = "joining";
      row.joinedInto = host.submissionId;
      touched.push(row);
      claimed.push({ ...submission, status: "joining", joinedInto: host.submissionId });
    }
    await this.persist(...touched);
    return claimed;
  }

  async finalizeJoinedSubmission(
    host: SubmissionAttemptRef,
    submissionId: string,
  ): Promise<boolean> {
    const row = this.joiningUnder(host, submissionId);
    if (!row) return false;
    row.status = "joined";
    row.inputAppliedAt ??= Date.now();
    await this.persist(row);
    return true;
  }

  async revertJoiningSubmission(
    host: SubmissionAttemptRef,
    submissionId: string,
  ): Promise<boolean> {
    const row = this.joiningUnder(host, submissionId);
    if (!row) return false;
    row.status = "queued";
    row.joinedInto = null;
    row.inputAppliedAt = null;
    await this.persist(row);
    return true;
  }

  // ── Leases ──────────────────────────────────────────────────────────

  async renewLeases(ownerId: string, submissionIds: string[]): Promise<void> {
    if (submissionIds.length === 0) return;
    const leaseExpiresAt = Date.now() + LEASE_DURATION_MS;
    const touched: SubmissionRow[] = [];
    for (const id of submissionIds) {
      const row = this.rows.get(id);
      if (row && row.ownerId === ownerId && row.status === "running") {
        row.leaseExpiresAt = leaseExpiresAt;
        touched.push(row);
      }
    }
    await this.persist(...touched);
  }

  // ── Internals ───────────────────────────────────────────────────────

  private admit(input: AgentSubmissionInput): Promise<AgentDispatchAdmission> {
    let inserted: SubmissionRow | undefined;
    const admission = admitSubmissionWithBackend<SubmissionRow>(input, {
      insertIfAbsent: (insert) => {
        if (this.rows.has(insert.submissionId)) return;
        inserted = {
          sequence: this.nextSequence++,
          submissionId: insert.submissionId,
          sessionKey: insert.sessionKey,
          kind: insert.kind,
          payload: insert.payload,
          status: "queued",
          acceptedAt: insert.acceptedAt,
          canonicalReadyAt: null,
          attemptId: null,
          inputAppliedAt: null,
          abortRequestedAt: null,
          startedAt: null,
          joinedInto: null,
          settledAt: null,
          error: null,
          attemptCount: 0,
          maxAttempts: DURABILITY_DEFAULT_MAX_ATTEMPTS,
          timeoutAt: 0,
          ownerId: null,
          leaseExpiresAt: 0,
          settlementRecordId: null,
          settlementRecord: null,
        };
        this.rows.set(insert.submissionId, inserted);
      },
      getExisting: (submissionId) => this.rows.get(submissionId),
      readChunks: (submissionId) => this.chunks.get(submissionId) ?? [],
      replaceChunks: (submissionId, chunks) => {
        this.chunks.set(submissionId, [...chunks]);
      },
      parseSubmission: (row, chunks) => parseRow(row, chunks),
    });
    // Every callback above is synchronous, so the shared algorithm returns
    // synchronously too — the whole admission is one atomic step.
    if (admission instanceof Promise) {
      throw new Error("[flue-workbench] Submission admission must be synchronous.");
    }
    const row =
      admission.kind === "submission" ? this.rows.get(admission.submission.submissionId) : inserted;
    return (row ? this.persist(row) : Promise.resolve()).then(() => admission);
  }

  private async settleOwned(attempt: SubmissionAttemptRef, error: string | null): Promise<boolean> {
    const row = this.ownedRunning(attempt);
    if (!row) return false;
    row.status = "settled";
    row.settledAt = Date.now();
    row.error = error;
    await this.persist(row, ...this.settleJoined(row.submissionId, error));
    return true;
  }

  /**
   * Joined-delivery fan-out when a host settles: `joined` rows settle with
   * the host's outcome; unconfirmed `joining` stragglers go back to the
   * queue so the delivery runs on its own instead of vanishing.
   */
  private settleJoined(hostSubmissionId: string, error: string | null): SubmissionRow[] {
    const touched: SubmissionRow[] = [];
    const now = Date.now();
    for (const row of this.rows.values()) {
      if (row.joinedInto !== hostSubmissionId) continue;
      if (row.status === "joined") {
        row.status = "settled";
        row.settledAt = now;
        row.error = error;
        touched.push(row);
      } else if (row.status === "joining") {
        row.status = "queued";
        row.joinedInto = null;
        row.inputAppliedAt = null;
        touched.push(row);
      }
    }
    return touched;
  }

  private ordered(): SubmissionRow[] {
    return [...this.rows.values()].sort((a, b) => a.sequence - b.sequence);
  }

  /** Queued, canonically ready, and the oldest unsettled row of its session. */
  private isRunnableHead(row: SubmissionRow): boolean {
    if (row.status !== "queued" || row.canonicalReadyAt === null) return false;
    for (const other of this.rows.values()) {
      if (
        other.sessionKey === row.sessionKey &&
        other.sequence < row.sequence &&
        UNSETTLED.has(other.status)
      ) {
        return false;
      }
    }
    return true;
  }

  private ownedRunning(attempt: SubmissionAttemptRef): SubmissionRow | undefined {
    const row = this.rows.get(attempt.submissionId);
    return row && row.status === "running" && row.attemptId === attempt.attemptId ? row : undefined;
  }

  private hostRunningUnder(hostId: string | null, attemptId: string): boolean {
    if (hostId === null) return false;
    const host = this.rows.get(hostId);
    return host?.status === "running" && host.attemptId === attemptId;
  }

  private joiningUnder(
    host: SubmissionAttemptRef,
    submissionId: string,
  ): SubmissionRow | undefined {
    const row = this.rows.get(submissionId);
    if (row?.status !== "joining" || row.joinedInto !== host.submissionId) return undefined;
    return this.ownedRunning(host) ? row : undefined;
  }

  private parse(row: SubmissionRow): AgentSubmission {
    return parseRow(row, this.chunks.get(row.submissionId) ?? []);
  }

  /**
   * Parse rows for an operational listing. A malformed row is terminalized
   * (settled with the parse error) instead of poisoning every later listing,
   * matching the reference store.
   */
  private parseOperational(rows: SubmissionRow[], status: "queued" | "active"): AgentSubmission[] {
    const parsed: AgentSubmission[] = [];
    for (const row of rows) {
      try {
        parsed.push(this.parse(row));
      } catch (error) {
        console.error(
          "[flue-workbench] Terminating malformed submission:",
          row.submissionId,
          error,
        );
        const expected = status === "queued" ? "queued" : "running";
        if (row.status === expected) {
          const message = error instanceof Error ? error.message : String(error);
          row.status = "settled";
          row.settledAt = Date.now();
          row.error = message;
          void this.persist(row, ...this.settleJoined(row.submissionId, message));
        }
      }
    }
    return parsed;
  }

  private persist(...rows: SubmissionRow[]): Promise<void> {
    if (rows.length === 0) return Promise.resolve();
    // Snapshot now: the rows keep mutating while the write is queued.
    const snapshots = rows.map(
      (row): SubmissionFile => ({
        row: { ...row },
        chunks: this.chunks.get(row.submissionId) ?? [],
      }),
    );
    return this.writes.run(async () => {
      for (const file of snapshots) {
        await writeJson(this.files, `${this.dir}/${submissionFileName(file.row.sequence)}`, file);
      }
    });
  }
}

function toObligation(row: SubmissionRow): SubmissionSettlementObligation {
  if (row.attemptId === null || row.settlementRecordId === null || row.settlementRecord === null) {
    throw new Error("[flue-workbench] Persisted submission settlement obligation is malformed.");
  }
  return {
    submissionId: row.submissionId,
    sessionKey: row.sessionKey,
    attemptId: row.attemptId,
    recordId: row.settlementRecordId,
    record: JSON.parse(row.settlementRecord) as SubmissionSettledRecord,
  };
}

function parseRow(row: SubmissionRow, chunks: readonly SubmissionChunkRow[]): AgentSubmission {
  const input = hydratePersistedSubmissionAttachments(
    JSON.parse(row.payload) as AgentSubmissionInput,
    chunks,
  );
  if (
    !isSubmissionPayload(input, {
      kind: row.kind,
      submissionId: row.submissionId,
      sessionKey: row.sessionKey,
      acceptedAt: row.acceptedAt,
    })
  ) {
    throw new Error("[flue-workbench] Persisted agent submission payload is malformed.");
  }
  return {
    sequence: row.sequence,
    submissionId: row.submissionId,
    sessionKey: row.sessionKey,
    kind: row.kind,
    input,
    status: row.status,
    acceptedAt: row.acceptedAt,
    canonicalReadyAt: row.canonicalReadyAt,
    ...(row.attemptId !== null ? { attemptId: row.attemptId } : {}),
    ...(row.inputAppliedAt !== null ? { inputAppliedAt: row.inputAppliedAt } : {}),
    ...(row.abortRequestedAt !== null ? { abortRequestedAt: row.abortRequestedAt } : {}),
    ...(row.startedAt !== null ? { startedAt: row.startedAt } : {}),
    ...(row.joinedInto !== null ? { joinedInto: row.joinedInto } : {}),
    ...(row.error !== null ? { error: row.error } : {}),
    ...(row.settledAt !== null ? { settledAt: row.settledAt } : {}),
    attemptCount: row.attemptCount,
    maxAttempts: row.maxAttempts,
    timeoutAt: row.timeoutAt,
    ...(row.ownerId !== null ? { ownerId: row.ownerId } : {}),
    leaseExpiresAt: row.leaseExpiresAt,
  };
}
