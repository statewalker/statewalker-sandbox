/**
 * Node-only accelerator. Kept in its own module so the portable modules never import
 * `node:crypto` — importing git-object-hash.ts must work in a browser, worker or Durable Object.
 */
import { createHash } from "node:crypto";
import type { Hasher } from "./git-object-hash.js";

export function createNodeSha1(): Hasher {
  const h = createHash("sha1");
  const self: Hasher = {
    update(b) {
      h.update(b);
      return self;
    },
    digest: () => new Uint8Array(h.digest()),
  };
  return self;
}
