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
              message: Messages.progressStep(i + 1, String(total)),
              work: { done: i, total },
            }),
        },
      );
      if (outcome.failures.length > 0) {
        const detail = outcome.failures
          .map((f) => `${f.step.from.path.base}: ${f.message}`)
          .join("\n");
        void this.messages.error(
          `${Messages.itemsFailed(outcome.failures.length, String(plan.steps.length))}\n${detail}`,
        );
      }
      return outcome;
    } finally {
      progress.cancel();
    }
  }
}
