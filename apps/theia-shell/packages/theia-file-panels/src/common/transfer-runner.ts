import type URI from "@theia/core/lib/common/uri";
import type { TransferPlan, TransferStep } from "./transfer-planner";

export interface TransferOps {
  copy(from: URI, to: URI, overwrite: boolean): Promise<unknown>;
  move(from: URI, to: URI, overwrite: boolean): Promise<unknown>;
}
export interface StepFailure {
  step: TransferStep;
  message: string;
}
export interface TransferOutcome {
  done: URI[];
  failures: StepFailure[];
  cancelled: boolean;
}

/** Runs the steps in order; a failing step is recorded and the rest still run. No rollback. */
export async function runPlan(
  plan: TransferPlan,
  ops: TransferOps,
  options: { isCancelled?: () => boolean; onStep?: (index: number, total: number) => void } = {},
): Promise<TransferOutcome> {
  const outcome: TransferOutcome = { done: [], failures: [], cancelled: false };
  const total = plan.steps.length;
  for (const [index, step] of plan.steps.entries()) {
    if (options.isCancelled?.()) {
      outcome.cancelled = true;
      break;
    }
    options.onStep?.(index, total);
    try {
      await ops[step.op](step.from, step.to, step.overwrite);
      outcome.done.push(step.to);
    } catch (error) {
      outcome.failures.push({
        step,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return outcome;
}
