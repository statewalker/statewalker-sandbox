// ctx.storage.sql's exec(query, ...bindings) over node:sqlite, for unit tests. Like workerd (and
// cellb's adapter), BLOBs are bound and returned as ArrayBuffer.
import { DatabaseSync } from "node:sqlite";

export function sql(db = new DatabaseSync(":memory:")) {
  const out = (v) =>
    v instanceof Uint8Array ? v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength) : v;
  return {
    db,
    exec(q, ...bindings) {
      const b = bindings.map((v) => (v instanceof ArrayBuffer ? new Uint8Array(v) : v));
      const st = db.prepare(q);
      if (/^\s*(SELECT|WITH)/i.test(q)) {
        const rows = st
          .all(...b)
          .map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, out(v)])));
        return { toArray: () => rows };
      }
      st.run(...b);
      return { toArray: () => [] };
    },
  };
}
