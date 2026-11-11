// Mock data shared by the prototypes. Names and numbers are invented; they only
// need to look like a small group running Sandclaw on its own machine.

export type Role = "admin" | "member";

// The group's people and devices, in the shapes of `@statewalker/group.core`
// (see the group.core grilling note). Dates are fixed so stories render the same
// every day: "now" in the prototypes is `today`.

/** "Now" for every prototype that shows dates. */
export const today = new Date("2026-10-10T10:00:00Z");

const daysAgo = (days: number, hour = 9) => new Date(Date.UTC(2026, 9, 10 - days, hour, 0, 0));

export interface Device {
  peerId: string;
  /** "Firefox on Linux", reported by the device itself. */
  label: string;
  online: boolean;
  isThisDevice: boolean;
  /** When the device joined the group. */
  addedAt: Date;
}

export interface Person {
  /** The person's public key, encoded. */
  id: string;
  /** From the person's signed profile. */
  name: string;
  role: Role;
  /** Any of their devices is online. */
  online: boolean;
  /** Seen by admins, and by the person themself. */
  devices?: Device[];
}

export interface PendingInvite {
  id: string;
  role: Role;
  /** The admin's note ("Paul"), seen only by admins. */
  label?: string;
  link: string;
  expiresAt: Date;
}

/** Claire is the admin; the prototypes run on her laptop unless they say otherwise. */
export const people: Person[] = [
  {
    id: "pk_claire",
    name: "Claire Morel",
    role: "admin",
    online: true,
    devices: [
      {
        peerId: "peer_c1",
        label: "Firefox on Linux",
        online: true,
        isThisDevice: true,
        addedAt: daysAgo(40),
      },
      {
        peerId: "peer_c2",
        label: "Safari on iPhone",
        online: false,
        isThisDevice: false,
        addedAt: daysAgo(2),
      },
    ],
  },
  {
    id: "pk_hugo",
    name: "Hugo Benali",
    role: "member",
    online: true,
    devices: [
      {
        peerId: "peer_h1",
        label: "Chrome on Windows",
        online: true,
        isThisDevice: false,
        addedAt: daysAgo(31),
      },
    ],
  },
  {
    id: "pk_ines",
    name: "Inès Garnier",
    role: "member",
    online: false,
    devices: [
      {
        peerId: "peer_i1",
        label: "Edge on Windows",
        online: false,
        isThisDevice: false,
        addedAt: daysAgo(25),
      },
      {
        peerId: "peer_i2",
        label: "Chrome on Android",
        online: false,
        isThisDevice: false,
        addedAt: daysAgo(12),
      },
    ],
  },
];

export const inviteLink = "https://app.sandclaw.ai/join#k=7f3a9c2e-atelier-morel";

export const pendingInvites: PendingInvite[] = [
  {
    id: "inv_paul",
    role: "member",
    label: "Paul (accounting)",
    link: inviteLink,
    expiresAt: new Date(Date.UTC(2026, 9, 16, 9)),
  },
];

/** What happened to an invite, as the hub records it (A10). */
export type InviteEventKind = "created" | "accepted" | "declined" | "expired" | "cancelled";

export interface InviteEvent {
  inviteId: string;
  kind: InviteEventKind;
  at: Date;
  /** The admin who created the invite, or who cancelled it. */
  by?: string;
  /** For `accepted`: who joined, and from which device. */
  person?: string;
  device?: string;
}

export interface IssuedInvite {
  id: string;
  label: string;
  role: Role;
  createdAt: Date;
  expiresAt: Date;
  createdBy: string;
}

export const issuedInvites: IssuedInvite[] = [
  {
    id: "inv_hugo",
    label: "Hugo",
    role: "member",
    createdAt: daysAgo(32),
    expiresAt: daysAgo(25),
    createdBy: "Claire Morel",
  },
  {
    id: "inv_ines",
    label: "Inès (design)",
    role: "member",
    createdAt: daysAgo(26),
    expiresAt: daysAgo(19),
    createdBy: "Claire Morel",
  },
  {
    id: "inv_marc",
    label: "Marc (intern)",
    role: "member",
    createdAt: daysAgo(20),
    expiresAt: daysAgo(13),
    createdBy: "Claire Morel",
  },
  {
    id: "inv_sophie",
    label: "Sophie Lambert",
    role: "member",
    createdAt: daysAgo(15),
    expiresAt: daysAgo(8),
    createdBy: "Claire Morel",
  },
  {
    id: "inv_ines2",
    label: "Inès — phone",
    role: "member",
    createdAt: daysAgo(12, 8),
    expiresAt: daysAgo(5, 8),
    createdBy: "Inès Garnier",
  },
  {
    id: "inv_accountant",
    label: "Accountant (temporary)",
    role: "member",
    createdAt: daysAgo(9),
    expiresAt: daysAgo(2),
    createdBy: "Claire Morel",
  },
  {
    id: "inv_paul",
    label: "Paul (accounting)",
    role: "member",
    createdAt: daysAgo(1),
    expiresAt: new Date(Date.UTC(2026, 9, 16, 9)),
    createdBy: "Claire Morel",
  },
];

export const inviteEvents: InviteEvent[] = [
  { inviteId: "inv_hugo", kind: "created", at: daysAgo(32), by: "Claire Morel" },
  {
    inviteId: "inv_hugo",
    kind: "accepted",
    at: daysAgo(31),
    person: "Hugo Benali",
    device: "Chrome on Windows",
  },
  { inviteId: "inv_ines", kind: "created", at: daysAgo(26), by: "Claire Morel" },
  {
    inviteId: "inv_ines",
    kind: "accepted",
    at: daysAgo(25),
    person: "Inès Garnier",
    device: "Edge on Windows",
  },
  { inviteId: "inv_marc", kind: "created", at: daysAgo(20), by: "Claire Morel" },
  { inviteId: "inv_marc", kind: "declined", at: daysAgo(18, 14) },
  { inviteId: "inv_sophie", kind: "created", at: daysAgo(15), by: "Claire Morel" },
  { inviteId: "inv_sophie", kind: "expired", at: daysAgo(8) },
  { inviteId: "inv_ines2", kind: "created", at: daysAgo(12, 8), by: "Inès Garnier" },
  {
    inviteId: "inv_ines2",
    kind: "accepted",
    at: daysAgo(12, 8),
    person: "Inès Garnier",
    device: "Chrome on Android",
  },
  { inviteId: "inv_accountant", kind: "created", at: daysAgo(9), by: "Claire Morel" },
  { inviteId: "inv_accountant", kind: "cancelled", at: daysAgo(6), by: "Claire Morel" },
  { inviteId: "inv_paul", kind: "created", at: daysAgo(1), by: "Claire Morel" },
];

export function initials(name: string): string {
  return name
    .split(" ")
    .map((part) => part[0])
    .join("")
    .slice(0, 2);
}

/** The group running Sandclaw: a name chosen at setup, and its admin. */
export const group = {
  name: "Atelier Morel",
  admin: "Claire",
};

export interface FolderEntry {
  name: string;
  /** Present for folders. */
  children?: FolderEntry[];
  /** Text of a Markdown file, where the prototypes need it (notes, todos). */
  text?: string;
}

/** The user's folder: the assistant's working context. */
export const folder: FolderEntry[] = [
  {
    name: "Clients",
    children: [
      { name: "contracts", children: [{ name: "Dupont — signed.pdf" }] },
      { name: "Dupont — offer.docx" },
      {
        name: "Dupont — notes.md",
        text: "# Dupont\n\n- [ ] Confirm the start date with Mr Dupont\n- [x] Visit the workshop\n",
      },
      { name: "Leroy — brief.pdf" },
    ],
  },
  {
    name: "Finance",
    children: [
      { name: "2026-Q3.xlsx" },
      { name: "invoices", children: [{ name: "INV-0412.pdf" }] },
    ],
  },
  {
    name: "Notes",
    children: [
      {
        name: "todo.md",
        text: "- [ ] Call Hugo about the Dupont offer\n- [ ] Send Q3 figures to the accountant\n- [x] Renew the insurance contract\n",
      },
      {
        name: "meeting 2026-10-02.md",
        text: "# Meeting with Dupont\n\nFollow-ups:\n- [ ] Send Dupont the revised phase 1 schedule\n- [ ] Ask Bois Lyonnais for the beam quote\n",
      },
    ],
  },
  { name: "Outputs", children: [{ name: "contacts.xlsx" }] },
];
