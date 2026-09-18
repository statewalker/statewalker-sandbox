import { createIntentLog, defineEvent } from "../../src/kernel/log.js";
import { alienCell } from "../../src/kit/alien-cell.js";
import { type Cell, cell } from "../../src/kit/cell.js";
import { modelContract, type Subject } from "./model-contract.js";

type V = { readonly n: number; readonly extra?: string };
const sample = (i: number): V => ({ n: i });
const twin = (v: V): V => ({ ...v });
const quiet = () => {};

const fromCell = (c: Cell<V>): Subject<V> => ({
  get: c.get,
  subscribe: c.subscribe,
  write: c.set,
  dispose: c.dispose,
});
const patch = (s: Subject<V>, p: Record<string, unknown>) =>
  (s as Subject<V> & { patch(p: Partial<V>): void }).patch(p as Partial<V>);
const withPatch = (c: Cell<V>) => ({ ...fromCell(c), patch: c.patch });

modelContract("cell (listener set)", () => withPatch(cell(sample(0), quiet)), sample, twin, {
  patch,
});
modelContract(
  "alienCell (alien-signals)",
  () => withPatch(alienCell(sample(0), quiet)),
  sample,
  twin,
  {
    patch,
  },
);

/**
 * A projection exposed to a view: the only writer is the log. `write` appends an event; the
 * projection folds it into the group. The contract holds through the log.
 */
const set = defineEvent<V>("contract:set");
modelContract(
  "projection over the intent log",
  () => {
    const core = createIntentLog();
    const scope = core.open("contract");
    const group = cell(sample(0), quiet);
    scope.project((r) => {
      if (r.kind === "intent" && r.type === set.id) group.set(r.payload as V);
    });
    return {
      get: group.get,
      subscribe: group.subscribe,
      write: (v: V) => void (!scope.closed && scope.append(set, v)),
      dispose: () => {
        scope.close();
        group.dispose();
      },
    };
  },
  sample,
  twin,
);
