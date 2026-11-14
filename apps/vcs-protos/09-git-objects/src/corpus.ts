import type { CorpusObject } from "./object-contract.js";

/** Decodes fixtures/corpus.json (raw objects as base64) without Node APIs. */
export function decodeCorpus(json: { name: string; id: string; type: string; raw: string }[]) {
  return json.map(
    (o) =>
      ({
        ...o,
        raw: Uint8Array.from(atob(o.raw), (c) => c.charCodeAt(0)),
      }) as CorpusObject,
  );
}
