import type { ConversationRecord } from "@flue/runtime/adapter";
import { createSessionStorageKey, PersistedFormatVersionError } from "@flue/runtime/adapter";
import {
  defineAttachmentStoreContractTests,
  defineConversationStreamStoreContractTests,
  defineStoreContractTests,
} from "@flue/runtime/test-utils";
import { writeText } from "@statewalker/webrun-files";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { beforeEach, describe, expect, it } from "vitest";
import { buildFilesViews } from "../../src/lib/build-files-views.js";
import { FilesApiSessionStore } from "../../src/lib/files-api-session-store.js";

// ── Flue 2 contract suites ────────────────────────────────────────────
//
// The executable specification of a Flue persistence adapter. Each test
// gets a fresh store over a fresh in-memory FilesApi (through the system
// view, exactly as the workbench wires it).

async function connectFresh() {
  const files = buildFilesViews(new MemFilesApi()).systemFiles;
  const adapter = new FilesApiSessionStore({ files });
  await adapter.migrate();
  return adapter.connect();
}

defineStoreContractTests("FilesApiSessionStore", {
  create: async () => (await connectFresh()).submissionStore,
  formatVersion: {
    open: () => new FilesApiSessionStore({ files: new MemFilesApi() }),
  },
});

defineConversationStreamStoreContractTests("FilesApiSessionStore", {
  create: async () => {
    const stores = await connectFresh();
    return { stream: stores.conversationStreamStore, submissionStore: stores.submissionStore };
  },
});

defineAttachmentStoreContractTests("FilesApiSessionStore", {
  create: async () => (await connectFresh()).attachmentStore,
});

// ── Workbench-specific behaviour ──────────────────────────────────────

type SystemFiles = ReturnType<typeof buildFilesViews>["systemFiles"];

const AGENT = "flue-workbench";
const ID = "workbench/repo-foo/main";
const PATH = `agents/${AGENT}/${ID}`;

// The store round-trips records as opaque JSON; we don't construct a real
// Flue message record here — what matters is that what we append comes back.
const userRecord = (id: string): ConversationRecord =>
  ({
    type: "message",
    id,
    message: { role: "user", content: "hello" },
  }) as unknown as ConversationRecord;

/** Write one canonical batch into the conversation of `ID`. */
async function seedConversation(adapter: FilesApiSessionStore, recordId = "m1") {
  await adapter.migrate();
  const { conversationStreamStore: stream } = await adapter.connect();
  await stream.createStream(PATH, { agentName: AGENT, instanceId: ID });
  const claim = await stream.acquireProducer(PATH, "producer-1");
  await stream.append({
    path: PATH,
    producerId: claim.producerId,
    producerEpoch: claim.producerEpoch,
    incarnation: claim.incarnation,
    producerSequence: claim.nextProducerSequence,
    records: [userRecord(recordId)],
  });
}

async function listAll(files: SystemFiles, dir: string) {
  const paths: string[] = [];
  for await (const entry of files.list(dir, { recursive: true })) paths.push(entry.path);
  return paths;
}

describe("FilesApiSessionStore (workbench behaviour)", () => {
  let systemFiles: SystemFiles;

  beforeEach(() => {
    systemFiles = buildFilesViews(new MemFilesApi()).systemFiles;
  });

  it("a conversation persists across store re-instantiation against the same FilesApi", async () => {
    await seedConversation(new FilesApiSessionStore({ files: systemFiles }));

    const reopened = new FilesApiSessionStore({ files: systemFiles });
    await reopened.migrate();
    const { conversationStreamStore } = await reopened.connect();
    const read = await conversationStreamStore.read(PATH);
    expect(read.batches).toHaveLength(1);
    expect(read.batches[0]?.records[0]?.id).toBe("m1");
    expect((await conversationStreamStore.getMeta(PATH))?.identity).toEqual({
      agentName: AGENT,
      instanceId: ID,
    });
  });

  it("submission ledger rows persist across re-instantiation", async () => {
    const first = new FilesApiSessionStore({ files: systemFiles });
    await first.migrate();
    const { submissionStore } = await first.connect();
    await submissionStore.admitDispatch({
      submissionId: "sub-1",
      agent: AGENT,
      id: ID,
      message: { kind: "user", body: "hi" },
      acceptedAt: "2026-06-03T00:00:00.000Z",
    });

    const reopened = await new FilesApiSessionStore({ files: systemFiles }).connect();
    const row = await reopened.submissionStore.getSubmission("sub-1");
    expect(row?.status).toBe("queued");
    expect(row?.sessionKey).toBe(createSessionStorageKey(AGENT, ID, "default", "default"));
  });

  it("encodes ids so slashes in them don't create nested directories", async () => {
    await seedConversation(new FilesApiSessionStore({ files: systemFiles }));
    const streamDirs: string[] = [];
    for await (const entry of systemFiles.list("/.settings/sessions/streams")) {
      streamDirs.push(entry.name);
    }
    // Exactly one stream directory — the slashes in the path were encoded.
    expect(streamDirs).toHaveLength(1);
    expect(streamDirs[0]).toMatch(/^[0-9a-f]+$/);
  });

  it("writes under /.settings/sessions by default", async () => {
    await seedConversation(new FilesApiSessionStore({ files: systemFiles }));
    expect(await systemFiles.exists("/.settings/sessions/meta.json")).toBe(true);
    expect(await systemFiles.exists("/.settings/sessions/streams")).toBe(true);
  });

  it("honours a custom root", async () => {
    await seedConversation(new FilesApiSessionStore({ files: systemFiles, root: "/.settings/x/" }));
    expect(await systemFiles.exists("/.settings/x/meta.json")).toBe(true);
    expect(await systemFiles.exists("/.settings/sessions")).toBe(false);
  });

  it("delete wipes the persisted conversation and ledger of one instance id only", async () => {
    const adapter = new FilesApiSessionStore({ files: systemFiles });
    await seedConversation(adapter);
    const { conversationStreamStore, submissionStore } = await adapter.connect();
    const otherPath = `agents/${AGENT}/other`;
    await conversationStreamStore.createStream(otherPath, {
      agentName: AGENT,
      instanceId: "other",
    });
    await submissionStore.admitDispatch({
      submissionId: "sub-1",
      agent: AGENT,
      id: ID,
      message: { kind: "user", body: "hi" },
      acceptedAt: "2026-06-03T00:00:00.000Z",
    });

    expect(await adapter.has(ID)).toBe(true);
    await adapter.delete(ID);
    expect(await adapter.has(ID)).toBe(false);
    expect(await adapter.has("other")).toBe(true);

    const reopened = await new FilesApiSessionStore({ files: systemFiles }).connect();
    expect((await reopened.conversationStreamStore.read(PATH)).batches).toHaveLength(0);
    expect(await reopened.conversationStreamStore.getMeta(otherPath)).not.toBeNull();
    expect(await reopened.submissionStore.getSubmission("sub-1")).toBeNull();
  });

  it("a torn trailing batch is dropped instead of failing the whole conversation", async () => {
    await seedConversation(new FilesApiSessionStore({ files: systemFiles }));
    const batchFile = (await listAll(systemFiles, "/.settings/sessions/streams")).find((p) =>
      p.includes("/batches/"),
    );
    if (!batchFile) throw new Error("expected a persisted batch file");
    // Simulate a second append whose write was cut short.
    await writeText(systemFiles, batchFile.replace(/0\.json$/, "1.json"), "{partial");

    const reopened = await new FilesApiSessionStore({ files: systemFiles }).connect();
    const read = await reopened.conversationStreamStore.read(PATH);
    expect(read.batches.map((b) => b.records[0]?.id)).toEqual(["m1"]);
  });

  it("a corrupted submission row is skipped, not fatal", async () => {
    await writeText(systemFiles, "/.settings/sessions/submissions/000000000001.json", "{partial");
    const stores = await new FilesApiSessionStore({ files: systemFiles }).connect();
    expect(await stores.submissionStore.hasUnsettledSubmissions()).toBe(false);
  });

  it("refuses Flue data that carries no format-version stamp", async () => {
    await seedConversation(new FilesApiSessionStore({ files: systemFiles }));
    await systemFiles.remove("/.settings/sessions/meta.json");
    await expect(new FilesApiSessionStore({ files: systemFiles }).migrate()).rejects.toThrowError(
      PersistedFormatVersionError,
    );
  });

  it("ignores Flue 0.7 session blobs left in the same directory", async () => {
    // 0.7 wrote `<hex(id)>.json` SessionData files at the root; Flue 2's
    // format is reset-only, so they are neither read nor treated as data.
    await writeText(systemFiles, "/.settings/sessions/776f726b.json", '{"version":3}');
    const adapter = new FilesApiSessionStore({ files: systemFiles });
    await expect(adapter.migrate()).resolves.toBeUndefined();
    await expect(adapter.connect()).resolves.toBeDefined();
  });
});
