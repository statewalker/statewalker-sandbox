import { defineViewKind } from "@sys/ui";

export interface ProgressBar {
  readonly label: string;
  /** 0..1 */
  readonly fraction: number;
}

export interface ProgressBarView {
  getBar(): ProgressBar;
  onBarUpdate(listener: () => void): () => void;
}

export const progressBarKind = defineViewKind<ProgressBarView>("progress:bar");
