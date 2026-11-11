/**
 * A strmap/strintmap that iterates in git's hashmap order (hashmap.c): FNV-1 `strhash`, 64
 * buckets growing 4× past 80% load, each bucket newest first. Where git iterates a hashmap and the
 * order shows (deferred directories, the highest directory-rename count), this map gives git's
 * order.
 */
export class GitStrMap<V> {
  private table: Entry<V>[][] = Array.from({ length: 64 }, () => []);
  private index = new Map<string, Entry<V>>();
  get size() {
    return this.index.size;
  }
  has(key: string) {
    return this.index.has(key);
  }
  get(key: string): V | undefined {
    return this.index.get(key)?.value;
  }
  set(key: string, value: V) {
    const known = this.index.get(key);
    if (known) {
      known.value = value;
      return;
    }
    const e = { key, value, hash: strhash(key) };
    this.index.set(key, e);
    this.table[e.hash & (this.table.length - 1)]?.unshift(e);
    if (this.index.size > Math.floor((this.table.length * 80) / 100)) {
      const old = this.table;
      this.table = Array.from({ length: old.length << 2 }, () => []);
      for (const chain of old)
        for (const x of chain) this.table[x.hash & (this.table.length - 1)]?.unshift(x);
    }
  }
  delete(key: string) {
    const e = this.index.get(key);
    if (!e) return;
    this.index.delete(key);
    const chain = this.table[e.hash & (this.table.length - 1)] as Entry<V>[];
    chain.splice(chain.indexOf(e), 1);
  }
  *entries(): Generator<[string, V]> {
    for (const chain of this.table) for (const e of chain) yield [e.key, e.value];
  }
  *keys(): Generator<string> {
    for (const [k] of this.entries()) yield k;
  }
}
interface Entry<V> {
  key: string;
  value: V;
  hash: number;
}

const enc = new TextEncoder();
/** `strhash`: FNV-1 over the bytes */
export function strhash(s: string): number {
  let h = 0x811c9dc5;
  for (const c of enc.encode(s)) h = (Math.imul(h, 0x01000193) ^ c) >>> 0;
  return h;
}
