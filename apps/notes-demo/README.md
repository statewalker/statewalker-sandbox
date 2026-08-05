# @statewalker/notes-demo

A browser note-taking app served **with no bundler** — it dogfoods the
[`@statewalker/webrun-modules-build`](../../../webrun-files/packages/webrun-modules-build)
no-bundle pipeline end to end.

`newProjectBuild({ project, cache })` scans the TS/TSX + CSS sources under `src/`
and emits a **static `.js` tree** into `dist/` (ext-map: `main.tsx` → `/~/main.js`,
`styles.css` → `/~/styles.js` `<style>`-injector, npm deps → `/~/~deps/…` proxies
resolved from the npm registry). The browser loads `/~/main.js` as a plain ES
module — **no bundler, no CDN, no import map**.

## What it proves (Phase-3 features)

- **Tailwind v4** — `src/styles.css` is a `@import "tailwindcss"` entry. The build's
  Tailwind transform generates the full utility stylesheet, honoring the
  `@theme { --color-brand: #4f46e5 }` token so `bg-brand` / `text-brand` exist.
- **F2 — `@import` CSS chain** — `styles.css` `@import "./tokens.css"`. The build
  follows the chain, applies `tokens.css`'s `@theme`, and emits a **real
  `/~/tokens.css`** alongside the injector.
- **F3 — `url()` asset** — `tokens.css` has `.logo { background-image:
  url("./logo.svg") }`. The build copies `src/logo.svg` **byte-identical** to
  `/~/logo.svg`; at runtime the injected `<style>`'s `url("./logo.svg")` resolves
  to it (see the `<base>` note below).

## Run it

```sh
pnpm build     # newProjectBuild: src/ → dist/  (first run fetches react from npm)
pnpm serve     # node:http static server for the dist/ tree
```

Then open <http://localhost:8899> (`PORT` overrides the port).

- **`?mem`** — <http://localhost:8899/?mem> boots the store on a fresh in-memory
  `MemFilesApi` (no persistence). The default boots a `MemFilesApi` hydrated from —
  and snapshotted back to — `localStorage`. The store (`src/store.ts`) is
  **FilesApi-only**, so any implementation (`BrowserFilesApi`/OPFS, `NodeFilesApi`)
  drops in unchanged.

## The `<base href="/~/">` requirement (F2/F3)

`index.html` sets `<base href="/~/">`. The Tailwind entry is emitted as a `<style>`
**injector** whose embedded CSS carries the `url("./logo.svg")` asset reference.
Relative URLs inside an injected `<style>` resolve against the **document base**,
not the injector module — so the base must be the emitted-tree root (`/~/`) for
`url("./logo.svg")` to resolve to the real `/~/logo.svg`. The same base lets the
ES-module import graph (`/~/main.js` → `./app.js` → …) resolve. Drop the `<base>`
and the asset 404s against the document root. See the comment in `index.html`.

## Test

```sh
pnpm test      # or: npx vitest run  (see note)
```

`test/build.test.ts` runs `newProjectBuild` with a `MemFilesApi` project + cache
(**no network** — Tailwind/CSS/assets are generated locally) and asserts the
emitted tree: Tailwind utilities + the custom `bg-brand`/`#4f46e5`, a real
`/~/tokens.css` (F2), a byte-identical `/~/logo.svg` (F3), and the `/~/main.js`
entry.

> Note: a second, unrelated `@statewalker/notes-demo` package exists in the
> `webrun-wire` workspace, so `pnpm --filter @statewalker/notes-demo test` matches
> both. Run `npx vitest run` from this directory to test only this app.
