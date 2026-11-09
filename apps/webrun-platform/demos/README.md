# webrun platform demos

Whole apps, built with their own toolchains where they have one, then bundled or compiled by the
platform, and run on Wrangler, celld and cellb. Private, and a pnpm workspace of its own: Astro
and EmDash bring hundreds of packages the platform does not need.

| Demo | What it is | How the platform handles it |
|---|---|---|
| `astro-app/` | Astro SSR: pages, an API route, a React island, a Durable Object (`Visits`) | `astro build`, then the bundler, in its object (1.2 MB worker) |
| `emdash/` | [EmDash](https://github.com/emdash-cms/emdash)'s `blog-cloudflare` template (D1, KV sessions, R2 media, cron, passkeys), unchanged from cellb.dev's example | `astro build`, then the bundler: 758 files, 38.5 MB in, a 22.9 MB worker out, on the Node runner (or in the object on hosts without the 128 MB limit) |
| `notebooks/` | a Markdown notebook (from statewalker-knowledge's demo) and an Observable Notebook Kit HTML document with Inputs, d3 and Observable Plot | sent as sources; compiled to pages in a `NotebookSite` object; their npm imports come from the site's module server |

## How to use it

```sh
pnpm install                         # here: the demos' workspace (own lockfile)
(cd .. && npm run build)             # the platform's per-host builds
npx tsx scripts/e2e.ts all           # every demo on Wrangler, celld and cellb
npx tsx scripts/e2e.ts celld emdash  # one host, one demo
CELLD_V8_HEAP_LIMIT_MB=2048 npx tsx scripts/e2e.ts all emdash --emdash-tier object   # EmDash bundled in the object
```

`scripts/e2e.ts` builds an Astro demo when its `dist/` is missing. celld is found at `CELLD_BIN`,
else `~/.cache/celld/celld` (`../scripts/get-celld.sh`). The browser checks need Playwright's
Chromium on the machine; pass `--no-browser` to skip them.

## What each check proves

For each host, the platform is started on it, then for each demo:

- **astro**:
  - the bundle the platform returns is unpacked and started on the same host;
  - the home page renders on the server and counts visits in its Durable Object;
  - a post page, the API route and the client asset answer;
  - in Chromium, the React island hydrates and counts clicks.
- **emdash**:
  - the bundle runs on the same host, with `EMDASH_SITE_URL` set in its `vars`;
  - EmDash's setup wizard applies the template's seed to D1;
  - the home page, a post, the RSS feed and the admin answer;
  - in Chromium, the home page links to the post and the post renders.
- **notebooks**:
  - both notebooks compile to pages with no failures, and the pages import from the site's
    module server;
  - in Chromium, Plot draws 60 dots and the summary cell runs;
  - changing the range input re-runs the dependent cells (100 points);
  - the Markdown notebook draws its plots.

## Internals

- `scripts/astro-project.ts` turns Astro's Cloudflare build into an input project:
  - `wrangler.json` comes from the adapter's, reduced to what a project declares, with
    `main: server/entry.mjs` and `assets.directory: client`;
  - `server/` holds the Worker's chunks; `client/` holds the static assets.
- The bundler bundles `server/entry.mjs` into one module. Wrangler would upload the chunks with
  `no_bundle`; the platform's build is one file that cellb and celld load the same way.
- `emdash/` is cellb.dev's `examples/emdash` sources: the template, with system fonts instead of
  Google fonts so the build runs offline. `scripts/apply-assetsignore.mjs` applies
  `.assetsignore` as `wrangler deploy` does.

## What will surprise you

- **EmDash logs `Error processing $media https://images.unsplash.com/…`** during setup without
  network access to Unsplash. The seed's sample images are downloaded then, and the posts are
  created without them.
- **The astro visit counter starts above 1**, because the host's readiness probe loads `/` first.
  The check compares two consecutive loads.
