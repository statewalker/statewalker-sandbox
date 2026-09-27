/**
 * Runs async steps one at a time, in call order. A failed step rejects only
 * its own caller's promise; the queue keeps going.
 */
export class SerialQueue {
  protected tail: Promise<unknown> = Promise.resolve();

  run<T>(step: () => Promise<T>): Promise<T> {
    const result = this.tail.then(step);
    this.tail = result.catch(() => undefined);
    return result;
  }
}
