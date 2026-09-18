import type { Contact, ContactPatch, ContactsApi } from "@b/contacts/api";

export const seedContacts: readonly Contact[] = Object.freeze([
  { id: "c1", name: "Ada Lovelace", email: "ada@example.org", phone: "+44 20 0001" },
  { id: "c2", name: "Alan Turing", email: "alan@example.org", phone: "+44 20 0002" },
  { id: "c3", name: "Grace Hopper", email: "grace@example.org", phone: "+1 212 0003" },
]);

/** In-memory `ContactsApi`; `update` rejects an empty name. Injected delay for tests. */
export class MemContactsApi implements ContactsApi {
  private _rows: Contact[];
  readonly calls: { method: string; args: unknown[] }[] = [];

  constructor(
    rows: readonly Contact[] = seedContacts,
    private readonly _delayMs = 0,
  ) {
    this._rows = rows.map((c) => ({ ...c }));
  }

  private async _enter(method: string, args: unknown[]): Promise<void> {
    this.calls.push({ method, args });
    if (this._delayMs > 0) await new Promise((r) => setTimeout(r, this._delayMs));
    else await Promise.resolve();
  }

  async list(): Promise<Contact[]> {
    await this._enter("list", []);
    return this._rows.map((c) => ({ ...c }));
  }

  async get(id: string): Promise<Contact | undefined> {
    await this._enter("get", [id]);
    const found = this._rows.find((c) => c.id === id);
    return found && { ...found };
  }

  async update(id: string, patch: ContactPatch): Promise<Contact> {
    await this._enter("update", [id, patch]);
    const current = this._rows.find((c) => c.id === id);
    if (!current) throw new Error(`contact not found: ${id}`);
    const next: Contact = { ...current, ...patch, id };
    if (next.name.trim() === "") throw new Error("Name is required");
    this._rows = this._rows.map((c) => (c.id === id ? next : c));
    return { ...next };
  }
}
