import type { Controller } from "../../kernel/context.js";
import { getSlots } from "../../kernel/slots.js";
import { useModel } from "../../kit/react/use-model.js";
import { reactRenderer, reactRenderersSlot } from "../shell/api/react.js";
import { type LogViewerView, logViewerKind } from "../sys.log-viewer/api/index.js";

function LogViewer({ model }: { model: LogViewerView }) {
  const lines = useModel(model.getLines, model.onLinesUpdate);
  const stats = useModel(model.getStats, model.onStatsUpdate);
  return (
    <div className="log-viewer">
      <p>
        appended {stats.appended} · retained {stats.retained} · pending {stats.pending}
      </p>
      <ol aria-label="Intent log">
        {lines.map((l) => (
          <li key={l.seq} value={l.seq} data-failed={l.failed || undefined}>
            <code>{l.text}</code>
          </li>
        ))}
      </ol>
    </div>
  );
}

export const activate: Controller = async (context) =>
  getSlots(context).register(
    reactRenderersSlot,
    logViewerKind.id,
    reactRenderer(logViewerKind, LogViewer),
  );
