/** Example data for the stories: Dirk, his services, his guests. */

import { type Guest, INVITE_TTL_MS, type Invite, type Service } from "../model.js";

export const now = new Date("2026-10-30T10:00:00Z");

export const fooService: Service = {
  id: "foo",
  name: "fooService",
  kind: "bridged",
  target: "http://localhost:5173",
  enabled: true,
  isDefault: true,
  health: "ok",
  warnings: [],
};

export const docs: Service = {
  id: "docs",
  name: "Product docs",
  kind: "direct",
  target: "https://docs.example.com",
  enabled: true,
  isDefault: false,
  health: "ok",
  warnings: [],
};

export const nas: Service = {
  id: "nas",
  name: "Photos",
  kind: "bridged",
  target: "http://nas.local:5000",
  enabled: false,
  isDefault: false,
  health: "disabled",
  warnings: [],
};

export const invite: Invite = {
  url: "https://tools.sandclaw.ai/peer-share/invite#join=eyJyZWxheUFkZHJzIjpb&from=Dirk",
  expiresAt: new Date(now.getTime() + INVITE_TTL_MS),
  used: false,
};

export const guests: Guest[] = [
  {
    peerId: "12D3KooWClaudia",
    name: "Claudia",
    joinedAt: new Date("2026-10-30T09:12:00Z"),
    online: true,
  },
  {
    peerId: "12D3KooWMarc",
    name: "Marc",
    joinedAt: new Date("2026-10-29T16:40:00Z"),
    online: false,
  },
];
