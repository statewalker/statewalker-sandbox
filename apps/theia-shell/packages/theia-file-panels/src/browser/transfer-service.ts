import { isCancelled } from "@theia/core/lib/common/cancellation";
import { ILogger } from "@theia/core/lib/common/logger";
import { MessageService } from "@theia/core/lib/common/message-service";
import type URI from "@theia/core/lib/common/uri";
import { inject, injectable } from "@theia/core/shared/inversify";
import { FileService } from "@theia/filesystem/lib/browser/file-service";
import { Messages } from "../common/file-panels-nls";
import type { TransferPlan } from "../common/transfer-planner";
import { runPlan, type TransferOutcome } from "../common/transfer-runner";

/** Runs a plan through Theia's FileService, with progress and one report of the failures. */
@injectable()
export class TransferService {
  @inject(FileService) protected readonly files!: FileService;
  @inject(MessageService) protected readonly messages!: MessageService;
  @inject(ILogger) protected readonly logger!: ILogger;

  async run(plan: TransferPlan): Promise<TransferOutcome> {
    if (plan.steps.length === 0) return { done: [], failures: [], cancelled: false };
    let cancelled = false;
    const progress = await this.messages.showProgress(
      { text: Messages.transferring(), options: { cancelable: true } },
      () => {
        cancelled = true;
      },
    );
    try {
      const outcome = await runPlan(
        plan,
        {
          copy: (from: URI, to: URI, overwrite: boolean) =>
            this.files.copy(from, to, { overwrite }),
          move: (from: URI, to: URI, overwrite: boolean) =>
            this.files.move(from, to, { overwrite }),
        },
        {
          isCancelled: () => cancelled,
          onStep: (i, total) =>
            progress.report({
              message: Messages.progressStep(i + 1, total),
              work: { done: i, total },
            }),
        },
      );
      if (outcome.failures.length > 0) {
        const lines = [
          Messages.itemsFailed(outcome.failures.length, plan.steps.length),
          ...outcome.failures.map((f) => Messages.failureLine(f.step.from.path.base, f.message)),
        ];
        void this.messages.error(lines.join("\n"));
      }
      return outcome;
    } finally {
      progress.cancel();
    }
  }

  /**
   * The one handling of a drop or transfer that failed as a whole (a resolve, the dialog, an
   * upload, a refresh): logged and shown as an error. A cancellation is not a failure.
   */
  reportError(error: unknown): void {
    if (error instanceof Error && isCancelled(error)) return;
    this.logger.error(error);
    void this.messages.error(
      Messages.transferFailed(error instanceof Error ? error.message : String(error)),
    );
  }
}
