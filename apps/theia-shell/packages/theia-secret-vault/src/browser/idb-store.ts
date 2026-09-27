/** A tiny key–value store: one IndexedDB database per name, one object store `entries`. */
export class IdbStore<T> {
  private db: Promise<IDBDatabase> | undefined;

  constructor(readonly name: string) {}

  get(key: string): Promise<T | undefined> {
    return this.run("readonly", (store) => store.get(key) as IDBRequest<T | undefined>);
  }

  async set(key: string, value: T): Promise<void> {
    await this.run("readwrite", (store) => store.put(value, key));
  }

  async delete(key: string): Promise<void> {
    await this.run("readwrite", (store) => store.delete(key));
  }

  private async run<R>(
    mode: IDBTransactionMode,
    op: (store: IDBObjectStore) => IDBRequest<R>,
  ): Promise<R> {
    this.db ??= openDatabase(this.name);
    const db = await this.db;
    return new Promise((resolve, reject) => {
      const request = op(db.transaction("entries", mode).objectStore("entries"));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
}

function openDatabase(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 1);
    request.onupgradeneeded = () => request.result.createObjectStore("entries");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
