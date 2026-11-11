# Provenance

`vendor/session-shell/` is copied from httpeers `apps/session-shell/src/` at commit
`4795a79`, because `@statewalker/httpeers-session-shell` is private (static files, not on
npm). Files: `client.ts`, `errors.ts`, `policy.ts`, `relay.ts`, `sw.ts`, `relay.html`,
`index.html`.

Three edits, each marked `PEERSHARE-PROTOS EDIT`. Two are in `policy.ts`:

1. `isLocalHost` also accepts `*.localhost`, so each session gets its own origin on one
   machine.
2. `frameAncestorsFor` (local only) also allows `https://127.0.0.1:*`, the public-page
   stand-in the viewer is served from.

The third is in `client.ts`, and is type-only: a tuple cast so the sandbox's
`noUncheckedIndexedAccess` accepts `first` (`servicesOf` already throws on an empty list).

Production behaviour (`*.p.httpeers.net`, `*.httpeers.net` parents) is unchanged. The
folder is excluded from Biome, so its formatting stays as upstream wrote it.
