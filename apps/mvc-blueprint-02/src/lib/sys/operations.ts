export interface OperationProgress {
  readonly label: string;
  readonly done: number;
  readonly total: number;
}

/** A long-running operation, contributed to `ops:running` by whoever runs it. A MODELS.md model. */
export interface RunningOperation {
  getProgress(): OperationProgress;
  onProgressUpdate(listener: () => void): () => void;
}
