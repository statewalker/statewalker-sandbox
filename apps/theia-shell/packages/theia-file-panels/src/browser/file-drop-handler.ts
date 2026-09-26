import { LabelProvider } from "@theia/core/lib/browser/label-provider";
import { ApplicationShell } from "@theia/core/lib/browser/shell/application-shell";
import { MessageService } from "@theia/core/lib/common/message-service";
import URI from "@theia/core/lib/common/uri";
import { inject, injectable } from "@theia/core/shared/inversify";
import { FileService } from "@theia/filesystem/lib/browser/file-service";
import {
  type CustomDataTransfer,
  type CustomDataTransferItem,
  FileUploadService,
} from "@theia/filesystem/lib/common/upload/file-upload";
import { Messages } from "../common/file-panels-nls";
import { invalidDrop, planTransfer, type TransferSource } from "../common/transfer-planner";
import { TransferDialog } from "./transfer-dialog";
import { TransferService } from "./transfer-service";

/** True only when at least one item resolves to a real WebKit filesystem entry. */
function hasUsableWebkitEntries(data: DataTransfer): boolean {
  return Array.from(data.items).some(
    (item) => typeof item.webkitGetAsEntry === "function" && item.webkitGetAsEntry() !== null,
  );
}

/** Wraps a plain file list as a CustomDataTransfer (no WebKit entries needed). */
function toCustomDataTransfer(files: FileList): CustomDataTransfer {
  return Array.from(files).map((file, index) => {
    const item: CustomDataTransferItem = {
      asFile: () => ({
        id: String(index),
        name: file.name,
        data: async () => new Uint8Array(await file.arrayBuffer()),
      }),
    };
    return [String(index), item] as const;
  });
}

/** Every drop into a panel: read the payload, refuse the impossible, ask, plan, run. */
@injectable()
export class FileDropHandler {
  @inject(FileService) protected readonly files!: FileService;
  @inject(FileUploadService) protected readonly upload!: FileUploadService;
  @inject(TransferService) protected readonly transfers!: TransferService;
  @inject(MessageService) protected readonly messages!: MessageService;
  @inject(LabelProvider) protected readonly labels!: LabelProvider;

  /** Returns the URIs written. Must be called synchronously from the drop event. */
  async drop(target: URI, data: DataTransfer, preferCopy: boolean): Promise<URI[]> {
    // Read everything before the first await: the browser clears the DataTransfer afterwards.
    const uris = ApplicationShell.getDraggedEditorUris(data);
    if (uris.length === 0) {
      if (data.files.length === 0) return [];
      // A real OS drag exposes WebKit entries (which the upload service uses to also recurse
      // into dropped folders); a File added programmatically to a DataTransfer never does, so
      // fall back to a flat CustomDataTransfer built straight from `.files` in that case.
      const source = hasUsableWebkitEntries(data) ? data : toCustomDataTransfer(data.files);
      const result = await this.upload.upload(target, { source });
      // FileUploadService.UploadResult.uploaded is a list of URI strings, not path segments.
      return result.uploaded.map((uri) => new URI(uri));
    }

    const stats = await this.files.resolveAll(uris.map((resource) => ({ resource })));
    const sources: TransferSource[] = stats.flatMap((result) =>
      result.success && result.stat
        ? [{ uri: result.stat.resource, isDirectory: result.stat.isDirectory }]
        : [],
    );
    if (sources.length === 0) return [];

    const invalid = invalidDrop(sources, target);
    if (invalid) {
      void this.messages.warn(Messages.intoItself(invalid.uri.path.base));
      return [];
    }

    const folder = await this.files.resolve(target);
    const existing = new Set((folder.children ?? []).map((child) => child.name));
    const allInTarget = sources.every((s) => s.uri.parent.isEqual(target));
    const firstName = sources[0].uri.path.base;
    const dialog = new TransferDialog({
      title: allInTarget
        ? Messages.sameFolderTitle(sources.length, firstName)
        : Messages.transferTitle(sources.length, firstName),
      sources,
      target,
      targetName: this.labels.getName(target),
      existing,
      preferCopy,
    });
    const choice = await dialog.open();
    if (!choice) return [];

    const plan = planTransfer({
      ...choice,
      sources,
      target,
      existing,
      copySuffix: Messages.copySuffix,
    });
    const outcome = await this.transfers.run(plan);
    return outcome.done;
  }
}
