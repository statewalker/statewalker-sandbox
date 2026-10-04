import {
  AttachmentConflictError,
  type AttachmentRef,
  type AttachmentStore,
  attachmentBytesEqual,
  copyAttachmentBytes,
  type GetAttachmentInput,
  type PutAttachmentInput,
  type StoredAttachment,
  sameAttachmentRef,
  verifyAttachmentBytes,
} from "@flue/runtime/adapter";
import type { FilesApi } from "@statewalker/webrun-files";
import { encodeSegment, readJson, WriteQueue, writeJson } from "./files-api-json.js";

/** `<dir>/<hex(streamPath)>/<hex(attachmentId)>.json` */
interface AttachmentFile {
  attachment: AttachmentRef;
  conversationId: string;
  /** Base64 — FilesApi stores bytes fine, but one JSON file keeps put atomic-ish. */
  bytes: string;
}

/**
 * Flue 2 `AttachmentStore` over a `FilesApi` directory: immutable attachment
 * bytes (images a user prompt carried) referenced by conversation records.
 *
 * Puts are serialized through one queue, so "check existing, then write"
 * is atomic with respect to other puts and concurrent exact puts both
 * succeed. Integrity (size + SHA-256 digest) is verified on the way in and
 * again on the way out, as the contract requires.
 */
export class FilesApiAttachmentStore implements AttachmentStore {
  private readonly files: FilesApi;
  private readonly dir: string;
  private readonly writes = new WriteQueue();

  constructor(opts: { files: FilesApi; dir: string }) {
    this.files = opts.files;
    this.dir = opts.dir;
  }

  flush(): Promise<void> {
    return this.writes.drain();
  }

  async put(input: PutAttachmentInput): Promise<void> {
    await verifyAttachmentBytes(input.attachment, input.bytes);
    const bytes = copyAttachmentBytes(input.bytes);
    const attachment = { ...input.attachment };
    await this.writes.run(async () => {
      const path = this.pathOf(input.streamPath, attachment.id);
      const existing = await readJson<AttachmentFile>(this.files, path);
      if (existing.kind === "ok") {
        if (
          !sameAttachmentRef(existing.value.attachment, attachment) ||
          existing.value.conversationId !== input.conversationId ||
          !attachmentBytesEqual(fromBase64(existing.value.bytes), bytes)
        ) {
          throw new AttachmentConflictError({
            path: input.streamPath,
            attachmentId: attachment.id,
          });
        }
        return;
      }
      const file: AttachmentFile = {
        attachment,
        conversationId: input.conversationId,
        bytes: toBase64(bytes),
      };
      await writeJson(this.files, path, file);
    });
  }

  async get(input: GetAttachmentInput): Promise<StoredAttachment | null> {
    await this.writes.drain();
    const file = await readJson<AttachmentFile>(
      this.files,
      this.pathOf(input.streamPath, input.attachmentId),
    );
    if (file.kind !== "ok" || file.value.conversationId !== input.conversationId) return null;
    const bytes = fromBase64(file.value.bytes);
    await verifyAttachmentBytes(file.value.attachment, bytes);
    return { attachment: { ...file.value.attachment }, bytes };
  }

  private pathOf(streamPath: string, attachmentId: string): string {
    return `${this.dir}/${encodeSegment(streamPath)}/${encodeSegment(attachmentId)}.json`;
  }
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  // Chunked so large images don't blow the argument limit of fromCharCode.
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
