# 07 — Does a Guest see the list, the Default Service and Pause without a reload?

`pnpm test 07-advertised-services`

**Answer: yes, but not through advertisements.** The hub posts its own advertisements
once, at creation (`ownAdvertisements`), and offers no way to change them. So one static
advertisement (`kind: "peershare"`, title "Dirk's services") says *that* Dirk shares.
*What* he shares is a live route, `GET /s/`, read per request by `serviceTable`, which
wraps rung 01's router.

```ts
serviceTable(() => services, { sharerName }): FetchHandler
// GET /s/        → [{ id, name, isDefault, paused }], Default first
// /s/<paused>/…  → 503, x-peershare-service: paused, "Dirk paused fooService…"
// /s/<unknown>/… → 404, x-peershare-service: unknown
```

## Measured, 2026-10-30 (over the real mesh)

- The catalog lists every Service, the Default one first.
- Pause: **the same Guest, without reconnecting**, gets the paused page and a paused
  catalog entry. Turning the Service back on restores it.
- An unknown Service is a marked 404.
- The Guest's mesh view carries exactly one PeerShare advertisement, naming the Sharer.

## Open

A Guest learns of changes by asking again. Live push (for example SSE via
`webrun-http-events`) is a UI decision, not a feasibility one.
