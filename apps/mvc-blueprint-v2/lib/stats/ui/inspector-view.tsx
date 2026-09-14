import { Card, CardContent, CardHeader, CardTitle } from "@statewalker/ui.view.shadcn";
import type { InspectorFilter, InspectorView } from "@stats/models";
import { useModel } from "@ui/react";

const LEVELS = ["trace", "debug", "info", "warn", "error", "fatal"] as const;

/** The log inspector: every record the stats backend received, newest first. */
export function InspectorPanel({ model }: { model: InspectorView }) {
  const entries = useModel(model.getEntries, model.onEntriesUpdate);
  const filter = useModel(model.getFilter, model.onFilterUpdate);
  const modules = useModel(model.getModules, model.onModulesUpdate);
  const dropped = useModel(model.getDropped, model.onDroppedUpdate);
  return (
    <Card className="w-full">
      <CardHeader className="flex flex-row items-center justify-between gap-4">
        <CardTitle>Log</CardTitle>
        <div className="flex items-center gap-3 text-sm">
          <label className="flex items-center gap-1">
            Level
            <select
              aria-label="Minimum level"
              className="rounded border px-1 py-0.5"
              value={filter.level}
              onChange={(e) =>
                model.setFilter({ level: e.target.value as InspectorFilter["level"] })
              }
            >
              {LEVELS.map((level) => (
                <option key={level} value={level}>
                  {level}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-1">
            Module
            <select
              aria-label="Module"
              className="rounded border px-1 py-0.5"
              value={filter.module}
              onChange={(e) => model.setFilter({ module: e.target.value })}
            >
              <option value="all">all</option>
              {modules.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </label>
          <span
            data-dropped
            title="Records suppressed because they were logged while a record was being delivered"
          >
            suppressed: {dropped}
          </span>
        </div>
      </CardHeader>
      <CardContent>
        <ol className="max-h-72 overflow-auto font-mono text-xs">
          {entries.map((r) => (
            <li key={r.seq} data-level={r.level} className="flex gap-2 border-b py-0.5">
              <span className="w-12 shrink-0 text-muted-foreground">{r.level}</span>
              <span className="w-16 shrink-0 text-muted-foreground">
                {String(r.metadata.module ?? "")}
              </span>
              <span className="shrink-0 font-semibold">{String(r.args[0])}</span>
              <span className="truncate text-muted-foreground">
                {r.args.length > 1 ? JSON.stringify(r.args.slice(1)) : ""}
              </span>
            </li>
          ))}
        </ol>
      </CardContent>
    </Card>
  );
}
