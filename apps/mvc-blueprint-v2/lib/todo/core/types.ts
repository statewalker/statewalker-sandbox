/** A record, not a model: nothing subscribes to a single todo. */
export interface Todo {
  id: string;
  title: string;
  done: boolean;
}

/**
 * The external service — this app's analogue of the Files Manager's `FilesApi`,
 * and deliberately not `FilesApi` itself (a domain noun cannot enter
 * the substrate, and borrowing consumer two's seam would distort the blueprint).
 *
 * EVERY method is async, `list()` included. A synchronous store would let a
 * controller read and write the model in one tick, at which point the layering
 * is a description of the file tree rather than of behaviour — and the
 * reconcile loop's coalescing would stop meaning anything, because it collapses two edges
 * precisely by awaiting. Every real backend is async; a blueprint whose seam is
 * not teaches a lesson that does not survive contact with one.
 *
 * It knows nothing of commands, models, views or the bus. B0 greps for that.
 */
export interface TodoApi {
  list(): Promise<Todo[]>;
  add(title: string): Promise<Todo>;
  toggle(id: string): Promise<Todo | undefined>;
  remove(id: string): Promise<boolean>;
  clearCompleted(): Promise<number>;
}
