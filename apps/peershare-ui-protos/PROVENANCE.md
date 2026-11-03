# Provenance

Everything under `src/vendor/` is copied from
[statewalker/sandclaw](https://github.com/statewalker/sandclaw) `apps/ui-protos.app`, at
commit `d9b89ebd3adf69356e40356c49dad0260a95a5bc`. The verbatim copy is its own commit
(`chore(peershare-ui-protos): scaffold … vendor ui-protos sources verbatim`), so
`git diff` against it shows every change. That diff is limited to adding `export` to
internals the PeerShare screens reuse.

| Here | Source (`apps/ui-protos.app/…`) | Changed | Used by |
|---|---|---|---|
| `src/vendor/mock.ts` | `src/mock.ts` | — | the vendored files' own imports |
| `src/vendor/services/services.tsx` | `src/services/services.tsx` | `export` on `HealthTag`, `Field`, `healthWords` | `peershare/sharer-services.tsx` |
| `src/vendor/services/endpoints.ts` | `src/services/endpoints.ts` | — | `services.tsx` |
| `src/vendor/link-device/link-device.tsx` | `src/link-device/link-device.tsx` | `export` on `CopyLink`, `QrPlaceholder`, `Countdown` | `peershare/invite-dialog.tsx` (`CopyLink`) |
| `src/vendor/link-device/flow.ts` | `src/link-device/flow.ts` | — | `link-device.tsx` |
| `src/vendor/join-invite/join-invite.tsx` | `src/join-invite/join-invite.tsx` | `export` on `Frame`, `EndPage` | `peershare/guest-join.tsx` |
| `src/vendor/team/team.tsx` | `src/team/team.tsx` | `export` on `Dot`, `Confirm`, `Badge`, `Choice` | `peershare/guests.tsx` (`Dot`, `Confirm`), `peershare/viewer-frame.tsx` (`Choice`) |
| `src/vendor/group-status/group-status.tsx` | `src/group-status/group-status.tsx` | — | `LinkState` type in the viewer |
| `src/index.css` | `src/index.css` | reformatted by Biome only | Storybook preview |
| `vite.config.ts`, `vitest.config.ts`, `tsconfig.json`, `test/setup.ts` | same paths | — | build and tests |
| `.storybook/main.ts`, `.storybook/preview.tsx` | same paths | story sort order only | Storybook |

**Looked at, not reused:**
- `GroupPill` hardwires the mock group's name ("Atelier Morel"), so the viewer draws
  its own dot with the same colours.
- `sites/site-parts` and `invitations-log` have nothing PeerShare needs yet.
- `services.tsx`'s `Services` screen is built on the hub's model (path, access,
  built-in), so `SharerServices` is a new controlled screen built on its parts.
