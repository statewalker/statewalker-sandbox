/**
 * Byte strings of any size in a Durable Object's SQLite: a row holds at most 2 MB there, so a
 * value is split into 1 MiB chunks. Used for a job's PDF, its pages' JSON and its PNG assets.
 */
import type { Sql } from "./models.ts";

const CHUNK = 1024 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export class BlobStore {
  constructor(private readonly sql: Sql) {
    sql.exec(
      "CREATE TABLE IF NOT EXISTS blob_chunk (key TEXT NOT NULL, idx INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY (key, idx))",
    );
    sql.exec("CREATE TABLE IF NOT EXISTS blob (key TEXT PRIMARY KEY, size INTEGER NOT NULL)");
  }

  put(key: string, bytes: Uint8Array): void {
    this.delete(key);
    for (let i = 0; i * CHUNK < bytes.byteLength; i++) {
      this.sql.exec(
        "INSERT INTO blob_chunk (key, idx, data) VALUES (?, ?, ?)",
        key,
        i,
        bytes.subarray(i * CHUNK, (i + 1) * CHUNK),
      );
    }
    this.sql.exec("INSERT INTO blob (key, size) VALUES (?, ?)", key, bytes.byteLength);
  }

  get(key: string): Uint8Array | null {
    const meta = this.sql.exec("SELECT size FROM blob WHERE key = ?", key).toArray()[0];
    if (!meta) return null;
    const bytes = new Uint8Array(Number(meta.size));
    let offset = 0;
    for (const row of this.sql
      .exec("SELECT data FROM blob_chunk WHERE key = ? ORDER BY idx", key)
      .toArray()) {
      const chunk = new Uint8Array(row.data as ArrayBuffer);
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    if (offset !== bytes.byteLength) throw new Error(`EIO: blob '${key}' is incomplete`);
    return bytes;
  }

  delete(key: string): void {
    this.sql.exec("DELETE FROM blob_chunk WHERE key = ?", key);
    this.sql.exec("DELETE FROM blob WHERE key = ?", key);
  }

  putJson(key: string, value: unknown): void {
    this.put(key, encoder.encode(JSON.stringify(value)));
  }

  getJson<T>(key: string): T | null {
    const bytes = this.get(key);
    return bytes ? (JSON.parse(decoder.decode(bytes)) as T) : null;
  }
}
