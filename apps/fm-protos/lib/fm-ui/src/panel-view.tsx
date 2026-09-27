import HighTable from "hightable";
import { createElement, type KeyboardEvent, useCallback, useMemo } from "react";
// The component ships the constraint it depends on. Leaving it to the host to
// remember is how the flex chain silently breaks (D2d).
import "./grid-host.css";
import type { PanelInputModel, PanelModel, TableModel } from "@fm/app";
import { FM_SELECTION, isExternalDrop, readSelection, writeSelection } from "./drag.js";
import { toDataFrame } from "./table-data-frame.js";
import { useModel } from "./use-model.js";

export interface PanelViewProps {
  panel: PanelModel;
  table: TableModel;
  /** Emitted on a drop. The view never performs the operation itself. */
  onDropFiles?(request: {
    files: { storage: string; path: string; kind: "file" | "directory" }[];
    target: { storage: string; path: string };
    sourcePanelId?: string;
    external: boolean;
  }): void;
}

/**
 * D2f — the panel, as a component.
 *
 * It knows two models and nothing else: no bus, no controller, no FilesApi.
 * Everything it reads comes from a model; everything the user does is written
 * into `panel.input` and decided by the controller.
 */
export function PanelView({ panel, table, onDropFiles }: PanelViewProps) {
  const path = useModel(panel, (m) => m.path);
  const stale = useModel(panel, (m) => m.stale);
  const error = useModel(panel, (m) => m.error);
  const rowCount = useModel(table, (t) => t.rowCount);
  const cursor = useModel(table, (t) => t.cursor);

  const { frame } = useMemo(() => toDataFrame(table), [table]);

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      const input = panel.input as PanelInputModel;
      switch (event.key) {
        case "ArrowDown":
          table.cursor = Math.min(table.cursor + 1, table.rowCount - 1);
          table.notify();
          break;
        case "ArrowUp":
          table.cursor = Math.max(table.cursor - 1, 0);
          table.notify();
          break;
        case " ": {
          // Selection is keyed by PATH (D2a), so it survives the refresh that
          // C4 may trigger under the user at any moment.
          const key = table.getRowKey(table.cursor);
          if (!key) break;
          const next = new Set(table.selected);
          next.has(key) ? next.delete(key) : next.add(key);
          table.selected = next;
          table.notify();
          break;
        }
        case "Enter": {
          const row = table.getRow(table.cursor);
          if (!row || row.kind !== "directory") break;
          // The view does not navigate. It states an intent; the controller
          // decides, and may decline.
          input.requestedPath = row.path;
          input.navigateCount++;
          input.notify();
          break;
        }
        case "Backspace": {
          input.backCount++;
          input.notify();
          break;
        }
        default:
          return;
      }
      event.preventDefault();
    },
    [panel, table],
  );

  const selectionRefs = useCallback(
    () =>
      [...Array(table.rowCount).keys()]
        .filter((row) => table.isSelected(row) || row === table.cursor)
        .map((row) => {
          const entry = table.getRow(row)!;
          return {
            storage: panel.storage,
            path: entry.path,
            kind: entry.kind as "file" | "directory",
          };
        }),
    [panel, table],
  );

  const onDragStart = useCallback(
    (event: { dataTransfer: DataTransfer | null }) => {
      if (!event.dataTransfer) return;
      writeSelection(event.dataTransfer, {
        sourcePanelId: panel.id,
        files: selectionRefs() as never,
      });
    },
    [panel, selectionRefs],
  );

  const onDragOver = useCallback((event: { preventDefault(): void }) => {
    // Claiming the drop is what stops the browser navigating to the payload.
    event.preventDefault();
  }, []);

  const onDrop = useCallback(
    (event: { preventDefault(): void; dataTransfer: DataTransfer | null }) => {
      event.preventDefault();
      if (!event.dataTransfer) return;
      const internal = readSelection(event.dataTransfer);
      if (internal) {
        if (internal.sourcePanelId === panel.id) return; // a drop onto itself is a no-op
        onDropFiles?.({
          files: internal.files as never,
          target: { storage: panel.storage, path: panel.path },
          sourcePanelId: internal.sourcePanelId,
          external: false,
        });
        return;
      }
      if (isExternalDrop(event.dataTransfer)) {
        onDropFiles?.({
          files: [],
          target: { storage: panel.storage, path: panel.path },
          external: true,
        });
      }
    },
    [panel, onDropFiles],
  );

  return createElement(
    "div",
    {
      className: "fm-panel fm-flex-fill",
      draggable: true,
      onDragStart,
      onDragOver,
      onDrop,
      "data-drag-type": FM_SELECTION,
      "data-path": path,
      "data-stale": stale ? "true" : "false",
      "data-cursor": String(cursor),
      "data-rows": String(rowCount),
      tabIndex: 0,
      onKeyDown,
    },
    createElement("div", { className: "fm-panel-breadcrumb" }, path),
    error ? createElement("div", { className: "fm-panel-error", role: "alert" }, error) : null,
    createElement(
      "div",
      { className: "fm-grid-host" },
      createElement(HighTable as never, {
        data: frame,
        selection: { ranges: table.selectionRanges() },
        focus: false,
      }),
    ),
  );
}
