import type { Contact, ContactApi } from "../contacts/api/index.js";

export const CONTACT_SEED: readonly Contact[] = [
  { id: "c1", name: "Ada Lovelace", email: "ada@example.org", phone: "+44 1" },
  { id: "c2", name: "Alan Turing", email: "alan@example.org", phone: "+44 2" },
  { id: "c3", name: "Grace Hopper", email: "grace@example.org", phone: "+1 3" },
];

/** In-memory contacts; `update` rejects an empty name — the deterministic failure. */
export function memContactApi(seed: readonly Contact[] = CONTACT_SEED, delayMs = 0): ContactApi {
  let contacts = seed.map((c) => ({ ...c }));
  const later = <T>(f: () => T): Promise<T> =>
    new Promise((resolve, reject) =>
      setTimeout(() => {
        try {
          resolve(f());
        } catch (e) {
          reject(e);
        }
      }, delayMs),
    );
  return {
    list: () => later(() => contacts.map((c) => ({ ...c }))),
    get: (id) => later(() => contacts.find((c) => c.id === id)),
    update: (id, patch) =>
      later(() => {
        const found = contacts.find((c) => c.id === id);
        if (!found) throw new Error(`no contact "${id}"`);
        const updated = { ...found, ...patch };
        if (updated.name.trim() === "") throw new Error("Name is required");
        contacts = contacts.map((c) => (c.id === id ? updated : c));
        return { ...updated };
      }),
  };
}
