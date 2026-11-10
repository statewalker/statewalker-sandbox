/** The committed base objects the fixture thin pack needs (what the receiver already has). */
import bases from "../fixtures/bases.json";
import type { ExternalBase, ObjectTypeName } from "./index-pack.js";

const fromBase64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
export const fixtureBase: ExternalBase = async (oid) => {
  const b = (bases as Record<string, { type: ObjectTypeName; base64: string }>)[oid];
  return b ? { type: b.type, data: fromBase64(b.base64) } : undefined;
};
