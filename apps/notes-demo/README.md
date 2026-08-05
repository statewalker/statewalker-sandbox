# @statewalker/webrun-notes-demo

A browser note-taking app served **with no bundler** — it dogfoods the
[`@statewalker/webrun-modules-build`](../../../webrun-files/packages/webrun-modules-build)
no-bundle pipeline end to end, and validates its Phase-3 CSS features in a real browser.

`newProjectBuild({ project, cache })` scans the TS/TSX + CSS sources under `src/`
and emits a **static `.js` tree** into `dist/` (ext-map: `main.tsx` → `/~/main.js`,
`styles.css` → `/~/styles.js` `<style>`-injector, npm deps → transformed files at
the tree root). The browser loads `/~/main.js` as a plain ES module — **no bundler,
no CDN, no import map**. The UI is **React** (`react`/`react-dom` served from npm,
transformed CJS→ESM on the fly), so the demo also exercises no-bundle React
end-to-end (createRoot, hooks, state).

> No-bundle React needs two webrun-modules transform behaviours the CSS-only demo
> didn't: the JSX runtime must match the globals' `NODE_ENV` (browser → production
> `jsx`), and React's `process.env.NODE_ENV`-gated package entry must be dead-code-
> eliminated to a **single** react instance (else react-dom's `ReactSharedInternals`
> is undefined and it crashes at render). Both landed in webrun-modules.

## What it proves (Phase-3 features, verified in-browser)

- **Tailwind v4** — `src/styles.css` is a `@import "tailwindcss"` entry. The build's
  Tailwind transform generates the full utility stylesheet, honoring the
  `@theme { --color-brand: #4f46e5 }` token so `bg-brand` exists. *(Verified: the
  logo chip + "New" button render `#4f46e5`; slate utilities apply.)*
- **F2 — `@import` CSS chain (kept at runtime)** — `src/theme.css` `@import
  "./palette.css"`. A **plain** (non-Tailwind) `@import` is KEPT in the emitted
  `<style>` injector, so it must resolve *at runtime*; the build also emits a real
  `/~/palette.css`. *(Verified: the injected `@import "./palette.css"` resolves
  against `<base href="/~/">` to `/~/palette.css`, whose `--note-line: #c7d2fe`
  colors the `.note-card` border.)* Note: the **Tailwind** entry instead **inlines**
  its `@import "./tokens.css"` (the design system resolves it), so the plain chain is
  what exercises the runtime `@import` case.
- **F3 — `url()` asset** — `src/tokens.css` has `.logo { background-image:
  url("./logo.svg") }`. The build copies `src/logo.svg` **byte-identical** to
  `/~/logo.svg`; the inlined `url("./logo.svg")` resolves against the `<base>`.

## Run it

```sh
pnpm build     # newProjectBuild: src/ → dist/
pnpm serve     # node:http static server for the dist/ tree
```

Then open <http://localhost:8899> (`PORT` overrides the port).

- **`?mem`** — <http://localhost:8899/?mem> boots the store on a fresh in-memory
  `MemFilesApi` (no persistence). The default boots a `MemFilesApi` hydrated from —
  and snapshotted back to — `localStorage`. The store (`src/store.ts`) is
  **FilesApi-only**, so any implementation (`BrowserFilesApi`/OPFS, `NodeFilesApi`)
  drops in unchanged.

## The `<base href="/~/">` requirement (F2/F3 runtime)

`index.html` sets `<base href="/~/">`. Relative URLs inside an injected `<style>`
(a kept `@import`, or a `url()` asset) resolve against the **document base**, not the
injector module — so the base must be the emitted-tree root (`/~/`) for
`@import "./palette.css"` and `url("./logo.svg")` to resolve to the real
`/~/palette.css` and `/~/logo.svg`. The same base is harmless for the ES-module
graph (module imports resolve by module URL). Drop the `<base>` and the injected
`@import`/asset 404 against the document root. See the comment in `index.html`.

## Test

```sh
npx vitest run   # from this directory
```

`test/build.test.ts` runs `newProjectBuild` with a `MemFilesApi` project + cache
(**no network**) and asserts the emitted tree: Tailwind utilities + the custom
`bg-brand`/`#4f46e5`, a real `/~/tokens.css` (F2), a byte-identical `/~/logo.svg`
(F3), and the `/~/main.js` entry.
