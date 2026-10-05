# @statewalker/byok-config-prototype

A throwaway Vite + React prototype. It edits an LLM connections config file in the style of a
"bring your own key" provider screen: a provider list, then per provider *prioritized* and
*fallback* key cards, each with its own model filters. The config is a JSON file the user picks
from disk; the app reads it, edits it and writes it back.

Do not build on it. The question it answers and what it found are in [NOTES.md](./NOTES.md).

## How to run it

1. `pnpm install` at the repo root.
2. `pnpm --filter @statewalker/byok-config-prototype dev`, then open <http://localhost:5179>.
3. Click **Open** and pick [`sample-config.json`](./sample-config.json).

## What will surprise you

- Saving back to the same file needs the File System Access API (Chrome, Edge). In Firefox and
  Safari the app still works, but opening goes through a file dialog and every save is a download.
- **Test** on a key card calls the provider's model-list endpoint with that key. It needs network
  access and a provider that allows the browser's CORS request.

## Reference

| Command | What it does |
| --- | --- |
| `pnpm --filter @statewalker/byok-config-prototype dev` | Vite dev server on port 5179 |
| `pnpm --filter @statewalker/byok-config-prototype build` | Production build |
| `pnpm --filter @statewalker/byok-config-prototype preview` | Serve the build on port 5179 |
| `pnpm --filter @statewalker/byok-config-prototype typecheck` | `tsc --noEmit` |
