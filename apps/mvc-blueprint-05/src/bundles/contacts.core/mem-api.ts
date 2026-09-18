import type { Contact, ContactApi } from "../contacts/api/index.ts";

export type Delay = number | (() => Promise<void>);
const wait = (delay: Delay | undefined) =>
  typeof delay === "function"
    ? delay()
    : new Promise<void>((resolve) => setTimeout(resolve, delay ?? 0));

export const CONTACT_SEED: readonly Contact[] = [
  { id: "c1", name: "Ada Lovelace", email: "ada@example.org", phone: "+44 20 0000 0001" },
  { id: "c2", name: "Alan Turing", email: "alan@example.org", phone: "+44 20 0000 0002" },
  { id: "c3", name: "Grace Hopper", email: "grace@example.org", phone: "+1 202 000 0003" },
];

export function createMemContactApi(
  options: { delay?: Delay; seed?: readonly Contact[] } = {},
): ContactApi {
  let contacts = [...(options.seed ?? CONTACT_SEED)];
  return {
    async list() {
      await wait(options.delay);
      return [...contacts];
    },
    async get(id) {
      await wait(options.delay);
      return contacts.find((c) => c.id === id);
    },
    async update(id, patch) {
      await wait(options.delay);
      const current = contacts.find((c) => c.id === id);
      if (!current) throw new Error(`no contact ${id}`);
      const updated = { ...current, ...patch };
      if (updated.name.trim() === "") throw new Error("Name is required");
      contacts = contacts.map((c) => (c.id === id ? updated : c));
      return updated;
    },
  };
}
