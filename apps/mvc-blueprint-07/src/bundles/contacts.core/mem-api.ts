import type { Contact, ContactApi } from "../contacts/api/index.js";

const SEED: readonly Contact[] = [
  { id: "c1", name: "Ada Lovelace", email: "ada@example.org", phone: "+44 1815 1210" },
  { id: "c2", name: "Alan Turing", email: "alan@example.org", phone: "+44 1912 0623" },
  { id: "c3", name: "Grace Hopper", email: "grace@example.org", phone: "+1 1906 1209" },
];

export function createMemContactApi(options: { delay?: number } = {}): ContactApi & {
  calls: Array<{ op: string; args: unknown[] }>;
} {
  let contacts = [...SEED];
  const calls: Array<{ op: string; args: unknown[] }> = [];
  const later = <T>(op: string, args: unknown[], fn: () => T): Promise<T> => {
    calls.push({ op, args });
    return new Promise<T>((resolve, reject) =>
      setTimeout(() => {
        try {
          resolve(fn());
        } catch (error) {
          reject(error);
        }
      }, options.delay ?? 0),
    );
  };
  const find = (id: string) => {
    const c = contacts.find((x) => x.id === id);
    if (!c) throw new Error(`no contact ${id}`);
    return c;
  };
  return {
    calls,
    list: () => later("list", [], () => contacts.map((c) => ({ ...c }))),
    get: (id) => later("get", [id], () => ({ ...find(id) })),
    update: (id, patch) =>
      later("update", [id, patch], () => {
        const next = { ...find(id), ...patch };
        if (next.name.trim() === "") throw new Error("Name must not be empty");
        contacts = contacts.map((c) => (c.id === id ? next : c));
        return { ...next };
      }),
  };
}
