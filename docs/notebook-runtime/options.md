# Notebook runtime: options and proposal

Status: exploration, no code yet. Date: 2026-10-31.

Goal: turn Markdown files into interactive sites, doing in the browser what Observable
notebook-kit's CLI and Observable Framework do under Node: parse, convert to notebook-kit's
format, resolve imports, transpile, build executable pages, skin them as a site. The same code
should also run on a portable server platform (Durable Objects via cellb). Candidate building
blocks named in the request: Portable Text as an intermediate format, Astro for themes.

## 1. What already exists

Most of the executable pipeline is already written and published. The proposal builds on it
instead of starting over.

| Piece | Where | What it already does | What it lacks for this goal |
|---|---|---|---|
| `@statewalker/notebook-build` | statewalker-knowledge | Markdown or notebook-kit HTML → notebook-kit `Notebook` → resolve `npm:` imports through a module server → `transpile()` → one `.html` page per notebook with `define()` calls; copies attachments; in static mode writes the whole dependency closure. Incremental on `webrun-builder`. No DOM globals, everything over `FilesApi`, so it already runs in a browser. | Site structure (nav, TOC, search), themes beyond one `stylesUrl`, fence attributes (`echo`, `database=`, `output=`), inline `${…}` in prose, `html`/`tex`/`dot`/`sql.view` cells (their builtins load from jsDelivr), data loaders (`node`/`python`/`r` cells have no interpreter stage). |
| `@statewalker/notebook-site` | statewalker-knowledge | One `SiteHandler` serving pages, `/_m/` modules (hosted mode) and an SSE rebuild stream. | Nothing structural; it is the serving seam. |
| `@statewalker/notebook-db` | statewalker-knowledge | SQL cells over any `db-api` database; build-time precompute of notebook-kit's cache files. | The build does not yet derive `PrecomputeRequest`s from cells. |
| `@statewalker/webrun-modules` | webrun-sites | Isomorphic module server: npm tarballs → ESM, served same-origin from a `FilesApi` cache; transpiles authored TS. | — |
| `@statewalker/webrun-bundler` | webrun-sites | esbuild-wasm bundler/transpiler over `FilesApi`, npm from registry, composed source maps, host-supplied modules. | — |
| `@statewalker/webrun-builder` | webrun-sites | Stage-level incremental build over files. | — |
| `@statewalker/webrun-cells` | webrun-sites | Key-level incremental engine whose whole state is SQLite (Node, DO storage, D1): queue, provenance, retraction, dead letters. | Not used by notebooks yet. |
| `@statewalker/webrun-site-builder` / `-site-host` | webrun-sites | `SiteHandler` composition; hosting it behind a same-origin ServiceWorker. | — |
| `@statewalker/webrun-files-*` | webrun-files | `FilesApi` over memory, Node, OPFS/FSA, S3, HTTP, SQLite, composite. | — |
| `@statewalker/cellb` | cellb.dev | Durable Objects runtime with a Cloudflare/celld surface, in Node and in the browser (OPFS SQLite in Dedicated Workers, ServiceWorker ingress); Worker Loader (dynamic workers), KV, R2, D1, WebSockets. | — |
| cellb.dev `site/` | cellb.dev | An Astro + Tailwind + shadcn site: the house style a theme could reuse. | — |

Consequence: the open design questions are not "how to parse and transpile" but

1. what the intermediate format is, and whether notebook-kit's `Notebook` is enough;
2. how a page becomes a site (structure and skin), and where Astro fits;
3. what drives the build and holds its state, in a tab and in a Durable Object;
4. how modules reach the page (unbundled vs bundled);
5. how the features notebook-kit leaves to Node or a CDN (builtins, data loaders) are brought
   in-house.

Each section below lists alternatives with pros and cons and ends with a recommendation.
Section 8 combines them into whole-system options.

## 2. Intermediate format

Today there is one IR: notebook-kit's `Notebook` (`{title, theme, cells: [{id, mode, value}]}`).
Prose is a `md` cell holding an opaque Markdown string.

### A1. Keep notebook-kit `Notebook` as the only IR

- Pro: no new format; round-trips with Observable Desktop and notebook-kit's HTML file format;
  `notebook-build` already does it.
- Pro: one less conversion to keep correct.
- Con: prose is an opaque string. A theme cannot get the heading outline (TOC), first paragraph
  (description), images, or links without reparsing Markdown in every consumer.
- Con: no place for inline expressions (`The total is ${total}.`); notebook-kit only has them
  inside an `md` cell compiled at run time, which `notebook-build` deliberately avoids
  (prose is rendered at build time so it reads with JavaScript off).
- Con: no stable per-block keys, so an editor or an incremental engine cannot tell "this
  paragraph changed" from "everything after it moved".

### A2. Portable Text as the document IR, `Notebook` derived from it

Markdown → Portable Text (PT) with a notebook schema; the executable `Notebook` is a projection
of the PT document (its code blocks), and the page model for the theme is another projection
(its prose, outline and metadata).

`@portabletext/markdown` (2.9.x, markdown-it based, so the same parser `notebook-build` already
uses) exports `markdownToPortableText`, `portableTextToMarkdown` and `applyMarkdownEdit`. Fenced
code becomes a `code` block object (`{language, code}`); inline code is a decorator; unknown
objects round-trip as ` ```json:object ` fences; losses are reported through `onDegradation`
instead of thrown. `applyMarkdownEdit` reconciles an edited Markdown text against an existing PT
document and keeps `_key`s where blocks survived.

Sketch of the notebook schema on top of the default one:

```ts
// block objects
{ _type: "cell", _key, mode: "js"|"ts"|"ojs"|"sql"|"html"|"tex"|"dot"|"node"|"python"|…,
  source: string, attrs: { echo?: boolean, run?: boolean, database?: string,
  output?: string, id?: string, … } }
// inline objects
{ _type: "expr", _key, source: "total.toFixed(2)" }      // from ${…} in prose
// document
{ _type: "notebook", path, meta: { title, theme, toc, … }, blocks: PortableTextBlock[] }
```

- Pro: structured, typed JSON with stable `_key`s. A theme reads headings, images and links
  directly; an incremental engine keys work by `_key`; inline `${…}` become `expr` objects
  rendered as tiny cells in a `<span>`.
- Pro: ecosystem: `@portabletext/to-html` (any runtime), `astro-portabletext` (Astro),
  `@portabletext/editor` (a structured editor, a later path to a WYSIWYG notebook editor), and
  `applyMarkdownEdit` for "edit Markdown, keep identity".
- Pro: Markdown stays the authoring format; PT is an internal, serializable artifact (it can be
  cached, diffed, stored in a DO's SQLite, sent over a port).
- Con: one more conversion layer and a schema to own (PT ↔ `Notebook` both ways, PT ↔
  notebook-kit HTML).
- Con: PT is block-flat (headings are block styles, not sections); nesting such as "cell inside a
  list item" or "cell inside a callout" needs custom handling. Front matter is not part of PT and
  must be split off first (as `md-parse.ts` already does).
- Con: the fence info string beyond the language (`js echo`, `sql database=x`) has to be checked
  against what `@portabletext/markdown` keeps in `language`; a custom `types.code` matcher may be
  needed. Not yet verified.
- Con: PT's editor and most tooling are React-centric; the core conversion packages are not.

### A3. mdast / unified (remark) as the IR

- Pro: the largest Markdown ecosystem (GFM, math, directives, MDX), and Astro's own Markdown
  pipeline is remark/rehype, so plugins could be shared with an Astro theme.
- Con: a syntax tree with source positions, not a storage or editing format; no stable identity
  across edits; heavier in the browser; a second Markdown parser next to markdown-it.

### A4. An own JSON cell-document schema

- Pro: exactly the fields needed, nothing else.
- Con: reinvents PT without its renderers, editor and Markdown round-trip.

**Recommendation: A2, two-level.** PT is the document IR (content, structure, identity);
notebook-kit's `Notebook` stays the executable IR, derived from PT, so `transpile()`,
`resolveNotebook()`, notebook-kit HTML import/export and Observable Desktop compatibility keep
working unchanged. Build it so A1 remains a degenerate path (a notebook-kit `.html` source maps
to PT with one block per cell).

### Fence attributes (needed under every option)

Markdown fences carry no attributes today, so `echo`, `run=false`, `database=…` and `output=…`
are only reachable from notebook-kit HTML. Adopt Observable Framework's info-string convention,
extended with `key=value`:

````md
```js echo
```sql database=warehouse output=revenue
```js run=false
````

It is backward-compatible with plain fences and with how Framework sites are written today.

## 3. From page to site: structure and skin

A site needs a page model (title, outline, prev/next, breadcrumbs), a site model (page tree,
navigation, search index) and a skin (layout HTML, CSS, small client JS). The notebook-specific
part is narrow: each cell needs a root element and its `define()` call, plus the notebook-kit
runtime and inspector styles.

Define one **theme contract** first, independent of the technology behind it:

```ts
interface NotebookTheme {
  assets: FilesApi;                                   // CSS, fonts, client JS
  renderPage(page: PageModel, site: SiteModel): string | Promise<string>;
}
// PageModel: { path, meta, outline, blocks (PT), cells: CellDefinition[], runtimeUrl, … }
// The theme renders prose from PT and calls a provided `renderCell(key)` that emits the
// cell root + inline define(); it never touches transpilation.
```

### F1. Plain template themes (no Astro)

A theme is HTML templates (a tiny tagged-template or `@portabletext/to-html` renderer) + CSS +
a few client scripts (nav toggle, search box).

- Pro: runs anywhere, including a ServiceWorker and a DO, with no build step; fast.
- Pro: smallest dependency surface; easy to ship a default theme inside the runtime.
- Con: weaker authoring experience than Astro components; layout logic is code.

### F2. Astro as the site generator (Node), notebooks as an Astro integration

An Astro content-layer loader reads the PT/page models (or the Markdown directly) from a
`FilesApi`; an Astro component `<NotebookCell>` emits the cell root and its `define()`; prose
renders through `astro-portabletext`. Starlight or the cellb.dev site's components provide nav,
TOC and search.

- Pro: full Astro ecosystem (Starlight, Tailwind, shadcn tokens already used by cellb.dev),
  image optimization, i18n, Pagefind search.
- Pro: lowest effort for a polished static export.
- Con: Node-only (Vite, Astro build). Breaks "purely in the browser" for the final export; the
  browser runtime would still need its own preview renderer, so there are two renderers to keep
  consistent.

### F3. Astro theme precompiled to a Worker, run by cellb

A theme is an Astro project built **once, at theme-publish time**, with the Cloudflare adapter
into a Worker (SSR). The notebook runtime loads that Worker (cellb Worker Loader, or as a project)
and asks it to render each page from the PT/page model passed in a request or read from a binding.
A static export is a crawl of the rendered routes into a `FilesApi`.

- Pro: authors write Astro; rendering happens in the browser, in a DO or on Cloudflare, without
  Node at site-build time.
- Pro: themes become versioned, swappable artifacts (one Worker bundle each).
- Con: unproven: Astro SSR output running under cellb in a browser is untested; bundle size;
  coupling to Astro's adapter output format across Astro versions (7.x today).
- Con: Astro features that need build-time Node (image optimization, Pagefind) are lost or must
  be replaced.

### F4. Astro "shell extraction"

Build an Astro theme once to static HTML shells with slot markers; the runtime fills slots.

- Pro: cheap; runs anywhere.
- Con: only static layout; per-page logic (active nav item, TOC) moves to client JS or to
  precomputed variants. A worse F1 with Astro as a template editor.

**Recommendation: the theme contract with F1 as the built-in default, F3 as the Astro path to
prototype, F2 as an optional exporter.** F1 keeps the browser and DO path self-contained; F3 is
the only option that gives Astro authoring without Node at build time, so it is worth a spike
(render one notebook page through an Astro SSR Worker under cellb in Node, then in Chromium).
F2 is a thin integration for people who already have an Astro site, and the Starlight docs
case.

## 4. Build orchestration and state

### C1. `webrun-builder` (status quo)

- Pro: works; incremental per notebook; state in a `FilesApi`.
- Con: stage-level convergence over files; per-cell or per-block granularity would be awkward;
  scanner state lives inside the source tree (`.notebook-build/`).

### C2. `webrun-cells` (SQLite-backed)

Signals and cells map naturally: `sources(path → md)` → `docs(path → PT)` →
`notebooks(path → Notebook)` → `pins(path → PinMap)` → `cells(path#key → CellDefinition)` →
`pages(path → html)`, plus `site(… → SiteModel)`. Provenance gives "delete a notebook prunes
what it published" for free.

- Pro: whole state is rows in SQLite, so it lives in a Durable Object's storage (`DoSqlDriver`),
  in D1 or in `node:sqlite`, and survives crashes; per-key granularity (a changed cell re-runs
  one transpile, not a whole notebook).
- Pro: failures park in dead letters while the rest converges (already the policy of
  `notebook-build`).
- Con: needs a SQLite in the tab (OPFS SQLite wasm) when not inside a DO; a rewrite of the
  orchestration in `build.ts` (781 lines), though not of the stages.
- Con: `webrun-cells` is new and unpublished in the README table.

### C3. Pure stages + content-addressed memo, no engine

- Pro: simplest for a live editor preview of one notebook (keystroke → re-run stages, memoized by
  hash).
- Con: no durable state, no pruning; not a site build.

**Recommendation:** keep the stages pure (they already are: `parseMarkdown`, `resolveNotebook`,
`transpileNotebook`, `renderPage`), use **C3 for live preview** and **C2 for site builds hosted
in a DO**. Keep C1 working until C2 has parity.

## 5. Execution platform

### D1. Page + ServiceWorker (status quo: `notebook-site` behind `webrun-site-host`)

- Pro: works today, zero server.
- Con: state per tab; no server-side work (data loaders, precomputed SQL); no sharing.

### D2. Durable Objects via cellb

One `NotebookProject` Durable Object per site:

```
NotebookProject DO
  storage.sql   ── webrun-cells state, sources/outputs as FilesApi over SQLite
  fetch()       ── SiteHandler: pages, /_m/ modules, /_events, /_api (edit, build)
  WebSocket     ── live rebuild events and, later, collaborative editing
  Worker Loader ── data loaders and server cells, each bundled by webrun-bundler
  R2 / KV       ── module cache shared across projects, exported sites
```

The same class runs on Cloudflare, on celld nodes, in Node (cellb) and in a browser tab (cellb's
browser host: SQLite on OPFS in a Dedicated Worker, requests through the ServiceWorker). A cell's
storage can move between them through the shared bucket.

- Pro: the "portable execution platform" the request asks for: one artifact, four hosts.
- Pro: durable, shareable state; a natural home for data loaders (Section 7) and SQL precompute.
- Pro: collaboration and live reload fall out of DO WebSockets.
- Con: the heaviest option. cellb ships TypeScript sources with no build step yet; Cloudflare CPU
  limits per request may cut long builds (cold module downloads), so the build must be resumable
  in slices, which `webrun-cells` provides but which has to be designed for.
- Con: two copies of heavy dependencies (notebook-kit's transpiler, possibly esbuild-wasm) inside
  the DO bundle.

### D3. Dedicated Worker + OPFS without the DO model

- Pro: simpler than D2; off the main thread.
- Con: an ad-hoc protocol that does not move to a server.

**Recommendation: target D2, keep D1 as its degenerate case.** Because every piece is a
`SiteHandler` over `FilesApi`, the DO is a thin wrapper: the build and site packages must not
import cellb. That way the plain ServiceWorker host keeps working and the DO is one host among
several.

## 6. Modules: resolution and bundling

### E1. Unbundled, same-origin module server (status quo, `webrun-modules`)

- Pro: incremental and shared across notebooks; a cell change touches no module; cache works
  offline.
- Con: many requests and an import waterfall on first load; a cold cache is slow
  (Plot, DuckDB).

### E2. Bundled per site with `webrun-bundler` (esbuild-wasm)

Cells stay runtime `define()`s (they must, for reactivity), but their npm imports are bundled into
one vendor chunk per page or per site.

- Pro: few requests, tree-shaking, composed source maps back to npm sources.
- Con: esbuild-wasm is ~10 MB and must be loaded where the build runs; any new import rebuilds
  the chunk; shared chunks across pages need a manifest.

### E3. CDN import maps (jsDelivr, esm.sh)

- Pro: trivial.
- Con: a third-party dependency at run time, which both `notebook-build` and `webrun-modules`
  explicitly exclude. Rejected.

**Recommendation: E1 for preview and hosted mode, E2 as an optional export optimization**
(`mode: "static-bundled"`), measured against E1's static closure before it is made the default.

## 7. Closing notebook-kit's gaps in-house

These are needed under every option and are the main "Framework parity" work.

1. **Builtins without a CDN.** `html`, `tex`, `dot` cells and `sql.view`/table display stay prose
   because notebook-kit's `recommendedLibraries` import `htl`, `katex`, `@viz-js/viz` and
   `@observablehq/inputs` from jsDelivr. Override those builtins (a page-level module that
   redefines them through the module server, or a patched `stdlib` served under `/_m/`), then
   widen `CODE_MODES`. Unlocks `Inputs`, `view()`, tables, TeX and Graphviz.
2. **Inline expressions.** `${…}` in prose → PT `expr` inline objects → one tiny cell each,
   rendered into a `<span>`, prose itself still rendered at build time.
3. **Data loaders.** Framework runs `*.json.js`-style loaders at build time; notebook-kit's
   `node`/`python`/`r` cells fetch `.observable/cache/<hash>.bin` produced by an interpreter
   stage. Provide that stage:
   - JS/TS loaders: bundle with `webrun-bundler`, run in a cellb Dynamic Worker (Worker Loader)
     or a Dedicated Worker in the tab, write the output to `FilesApi` at the path notebook-kit
     expects.
   - Python: Pyodide in a worker is possible but heavy; leave out of the first iteration.
   - Shell/other interpreters: out of scope in the browser; allowed only on a Node host.
4. **SQL precompute.** Derive `PrecomputeRequest`s from `sql` cells with a `database=` attribute
   (now expressible from Markdown, Section 2) and call `notebook-db`'s `precomputeQueries`.
5. **Site model.** Page tree from the file tree plus an optional `notebooks.config` (title, pages,
   order, theme), prev/next, breadcrumbs, and a search index built from PT text blocks
   (MiniSearch-style JSON, no Node-only Pagefind).

## 8. Whole-system alternatives

| | Option 1: extend in place | Option 2: PT-centric portable runtime (recommended) | Option 3: Astro-first | Option 4: port Observable Framework |
|---|---|---|---|---|
| IR | notebook-kit `Notebook` | PT document → `Notebook` + page model | mdast inside Astro | Framework's own |
| Skin | templates around `renderPage` | theme contract; F1 default, F3 Astro spike | Astro / Starlight | Framework themes |
| Orchestration | `webrun-builder` | stages + `webrun-cells` | Astro build | Framework build |
| Platform | page + SW | DO (cellb), SW as degenerate case | Node, static hosting | Node |
| In-browser build | yes | yes | no | no without a large port |
| Effort | small | medium-large | small-medium | large |
| Main risk | prose stays opaque; ceiling on themes and editing | scope; cellb/Astro-SSR integration unproven | not browser-native; two renderers | Framework is Node-centric (fs, its own dev server, rollup); Observable's own focus moved to notebook-kit 2 |

- **Option 1** adds fence attributes, CDN-free builtins and a template theme to
  `notebook-build`. It ships value quickly but leaves no structured content for themes or an
  editor and does not use DOs.
- **Option 2** layers new packages on top of the existing ones (below). Every stage stays
  usable on its own, and Option 1's improvements are its first milestones.
- **Option 3** is right if the goal were only a nicer static export. It does not satisfy
  "purely in the browser".
- **Option 4** is rejected: it would mean re-hosting a Node application in the browser against
  the direction of its upstream.

## 9. Proposed package layout for Option 2

```
@statewalker/notebook-md       Markdown (+ front matter, fence attrs) ⇄ PT with the notebook schema
                               (wraps @portabletext/markdown; applyMarkdownEdit for key-stable edits)
@statewalker/notebook-ir       the PT schema; PT ⇄ notebook-kit Notebook; PT → PageModel (outline,
                               meta, expr cells); notebook-kit HTML ⇄ PT
@statewalker/notebook-build    unchanged stages (resolve, transpile, materialize); renderPage moves
                               behind the theme contract; orchestration on webrun-cells (C2)
@statewalker/notebook-builtins CDN-free htl / tex / dot / Inputs for notebook-kit's runtime
@statewalker/notebook-loaders  data-loader stage: bundle (webrun-bundler) + run (Worker / Dynamic Worker)
@statewalker/notebook-theme    the contract + the default F1 theme
@statewalker/notebook-theme-astro  F3 adapter (Astro SSR Worker) — spike first
@statewalker/notebook-site     unchanged: SiteHandler composition
@statewalker/notebook-do       NotebookProject Durable Object (cellb / Cloudflare / celld)
```

Data flow:

```
 *.md ──notebook-md──► PT doc ──notebook-ir──► Notebook ──resolve──► pins ──transpile──► cells
                         │                                                                 │
                         └────────────► PageModel ◄────────────────────────────────────────┘
                                           │
                     SiteModel ──► theme.renderPage ──► pages ──► FilesApi output
                                           │
                     notebook-site (SiteHandler) ──► SW host │ cellb DO │ Node │ Cloudflare
```

## 10. Milestones

1. **Fence attributes + inline expressions** in `notebook-build`'s Markdown parser (useful even
   without PT). Done when `js echo`, `sql database=… output=…` and `${…}` work from `.md`.
2. **CDN-free builtins**; widen `CODE_MODES`; browser test asserting zero off-origin requests
   with `Inputs`, `tex` and `dot` cells.
3. **`notebook-md` + `notebook-ir`**: Markdown → PT → `Notebook` with byte-identical
   transpile output to today's path on the existing test corpus.
4. **Theme contract + default theme + site model** (nav, TOC, prev/next, search index).
5. **`webrun-cells` orchestration**, parity with the incremental tests of `notebook-build`.
6. **`notebook-do`** on cellb in Node, then in Chromium; same handler on Cloudflare.
7. **Data loaders** (JS/TS) via Worker Loader; SQL precompute from cell attributes.
8. **Spike: Astro SSR theme under cellb** (F3). Keep or drop based on the result.
9. Optional: `static-bundled` export (E2) and a PT-editor-based notebook editor.

## 11. Open questions

- Is Observable Desktop / notebook-kit HTML round-trip a hard requirement? It decides whether PT
  must carry every notebook-kit attribute (pinned, hidden, display modes) or only the Markdown
  subset.
- Which notebook-kit version to pin (statewalker-knowledge uses ^2.6.6; npm has 2.9.1), and
  whether overriding its builtins is stable across its releases or needs a fork of `stdlib`.
- Should a site be one DO, or one DO per notebook with a site-level DO aggregating? One per site
  is simpler; per notebook scales edits and isolates failures.
- Does the fence info string survive `@portabletext/markdown` intact in `language`, or is a custom
  code matcher required? (Check before milestone 3.)
- How much of Framework's syntax to accept verbatim (`observablehq.config.js`, `<div class="grid">`,
  `display()`/`view()` semantics) so existing Framework sites build unchanged.
