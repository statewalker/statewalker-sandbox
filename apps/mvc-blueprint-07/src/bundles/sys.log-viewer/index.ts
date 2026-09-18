import { type Controller, useFields } from "../../kernel/context.js";
import { getIntentLog, type LogRecord } from "../../kernel/log.js";
import { getSlots } from "../../kernel/slots.js";
import { cell } from "../../kit/cell.js";
import { panelsSlot } from "../shell/api/index.js";
import { type LogLine, type LogViewerView, logViewerKind } from "./api/index.js";

const SHOWN = 200;
const fields = useFields({ slots: getSlots, core: getIntentLog });
const line = (r: LogRecord): LogLine => ({
  seq: r.seq,
  failed: r.kind === "outcome" && !r.ok,
  text:
    r.kind === "intent"
      ? `${r.origin} → ${r.type} ${JSON.stringify(r.payload) ?? ""}${r.cause ? ` (cause #${r.cause})` : ""}`
      : `  ${r.ok ? "✓" : "✗"} #${r.cause} ${r.type} ${r.ok ? (JSON.stringify(r.value) ?? "") : r.error}`,
});

/** The intent log viewer: a replaying projection of the last records, as a main panel. */
export const activate: Controller = async (context) => {
  const { slots, core } = fields(context);
  const log = core.open("sys.log-viewer");
  const lines = cell<readonly LogLine[]>([]);
  const stats = cell({ appended: 0, retained: 0, pending: 0 });
  const off = log.project(
    (record) => {
      lines.set([...lines.get(), line(record)].slice(-SHOWN));
      const { appended, retained, pending } = core.stats();
      stats.set({ appended, retained, pending });
    },
    { replay: true },
  );
  const model: LogViewerView = Object.freeze({
    getLines: lines.get,
    onLinesUpdate: lines.subscribe,
    getStats: stats.get,
    onStatsUpdate: stats.subscribe,
  });
  const withdraw = slots.register(panelsSlot, "sys:log-viewer", {
    kind: logViewerKind,
    title: "Intent log",
    placement: "main",
    order: 90,
    model,
  });
  return () => {
    withdraw();
    off();
    log.close();
    lines.dispose();
    stats.dispose();
  };
};
