# BYOK config prototype — THROWAWAY

**This is a prototype. Do not build on it; delete it or fold the answer back in.**

## The question

> Should the workbench's AI connections UI adopt the **OpenRouter BYOK flow**
> (provider list → provider page → *prioritized* / *fallback* key cards, each with
> its own model filters) instead of today's provider-as-tabs, one-key-per-connection
> layout in `@statewalker/ai-config.core`'s `connections-spec.ts`?
>
> And: does a **file-backed** connections config — the user picks a JSON file on
> disk, the app reads it, edits it, writes it back — hold up as the persistence
> model?

## Run it

```bash
pnpm --filter @statewalker/byok-config-prototype dev   # → http://localhost:5179
```

Use **Chrome/Edge** for the real flow: the File System Access API is what lets the
app write back to the *same* file the user picked. In Firefox/Safari the app still
works, but reads go through a file dialog and every save is a download.

`sample-config.json` in this folder is a hand-written config to try **Open** with.
It exercises both tiers, both filter modes, and the `clientKeys` list.

## What it reproduces

Every step of `notes/2026/2026-08/2026-08-11/byok-guide/` (the saved OpenRouter
guide + screenshots):

| Guide step | Here |
| --- | --- |
| 1 — BYOK provider list with "Not configured" | `providers-screen.tsx` (shows `N keys` once configured) |
| 2 — provider page, Prioritized / Fallback | `provider-screen.tsx` |
| 3 — "+ Add key" expands the new-key form | `key-card.tsx`, open by default when blank |
| 4 — name + masked API key | `key-card.tsx` |
| 5 — eye toggle, Save (top-right) | `key-card.tsx` + `provider-screen.tsx` |
| 6 — FILTERS · Models · All → Specific | `filter-row.tsx` + `ui/segmented.tsx` |
| 7 — "+ Add" searchable, date-grouped model list | `item-picker.tsx` |
| 8 — selected model as a removable chip | `filter-row.tsx` |

Deliberate departures:

- **Drag-to-reorder is a button.** The guide's "drag a key by its handle to
  reorder it or move it between sections" is one ↓/↑ button per card. Ordering
  within a section is not editable.
- **Test hits the provider for real, and the model select is gone.** Pressing
  Test GETs the provider's live model-list endpoint with the key in the form
  field, reports `N models · 240 ms` or the provider's own error, and **replaces
  the seed catalog with the real model list** for the rest of the session. A
  list call was chosen over an inference call: it validates key + endpoint +
  CORS, costs no tokens, and returns something the UI can use. That leaves the
  guide's model dropdown beside Test with no job, so it was removed rather than
  left as decoration.
- **The API Keys filter is real, not decorative.** It filters over
  `config.clientKeys`, which the config file declares. With no client keys
  declared, the picker says so instead of inventing entries.
- **A file bar** replaces the OpenRouter chrome (sidebar, marketing banner), plus a
  live JSON pane showing exactly what `Save` writes.

## Live Test requests

| Provider | Call | Notes |
| --- | --- | --- |
| Anthropic | `GET api.anthropic.com/v1/models` | needs `anthropic-dangerous-direct-browser-access: true` |
| OpenAI · Mistral · Groq · Together · Fireworks | `GET <base>/models`, `Authorization: Bearer` | Together answers with a bare array, not `{data}` |
| Google AI Studio | `GET generativelanguage.googleapis.com/v1beta/models` | `x-goog-api-key` header |
| Amazon Bedrock · Azure · OpenAI-compatible | — | not testable: SigV4, a per-resource endpoint, and a missing base-URL field respectively; the button is disabled with the reason beside it |

The key goes straight from the form field to the provider over TLS. That is only
acceptable because this is a prototype; a real client proxies.

## Incomplete keys are never written

A key counts as configured **only once it carries an API key** — name stays
optional, as in the guide. Blank or name-only cards live in the editing session
(marked `not saved — no API key`) but are dropped by `serializeConfig` and not
counted by `keyCount`, so an untouched "+ Add key" cannot make a provider read as
configured or leave an empty entry in the file. The JSON pane shows the truth as
you type.

## Config shape being tried out

`src/config.ts` is the part worth keeping — pure, DOM-free, and the actual
proposal. It differs from today's `AiConfigData` on three axes:

1. **N keys per provider, not one connection per key.** `providers[<id>]` holds
   `prioritized[]` + `fallback[]`.
2. **Ordered fallback tiers** are first-class, rather than implied by a
   connection list.
3. **Per-key model scoping** (`models: {mode:"all"|"specific", ids}`) instead of
   per-connection `starredModelIds`.

The credential lives **in the file**, which is the loudest open question — see
below. `AiConfigData` deliberately keeps keys in the `Secrets` adapter.

## Verified

- All 8 guide steps driven in a browser; the JSON pane tracked every edit.
- `parseConfig` → `serializeConfig` → `parseConfig` is stable, including on the
  hand-written `sample-config.json`.
- Tolerant parse: invalid JSON, a non-object top level, `providers: 42`, and an
  empty file each yield a usable empty config plus a stated warning.
- Test reaches all three flagship providers **from the browser** — deliberately
  invalid keys returned `401 invalid x-api-key` (Anthropic), `401 Incorrect API
  key provided` (OpenAI) and `400 API key not valid` (Google), which is also the
  proof that CORS lets these calls through at all.
- The 200 path was verified against **captured real responses** (124 OpenAI
  models, 52 Gemini models) driven back through `testConnection`: ids, labels
  and newest-first date grouping all come out right.
- `pnpm typecheck` and `pnpm build` are clean.
- **Not** verified end-to-end: a live 200 in the browser (that needs a real key
  typed by hand), and the File System Access open/save-in-place path (that needs
  a human at the file dialog). The download fallback was exercised.

## Answer

_To fill in after flipping through it:_

- Does the prioritized/fallback split earn its complexity, or is one ordered list
  enough?
- Is a plaintext key in a user-chosen file acceptable here, or must this stay on
  `Secrets` (which would make the file a credential-free reference document, and
  the "pick a file" flow much less useful)?
- Does the provider list → provider page navigation beat provider-as-tabs once
  there are only 3–4 configured providers?
- Verdict:
