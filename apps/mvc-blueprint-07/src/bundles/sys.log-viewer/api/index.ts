import { defineViewKind } from "../../../kernel/models.js";

export interface LogLine {
  readonly seq: number;
  readonly text: string;
  readonly failed: boolean;
}
export interface LogViewerView {
  getLines(): readonly LogLine[];
  onLinesUpdate(listener: () => void): () => void;
  getStats(): { readonly appended: number; readonly retained: number; readonly pending: number };
  onStatsUpdate(listener: () => void): () => void;
}
export const logViewerKind = defineViewKind<LogViewerView>("sys:log-viewer");
