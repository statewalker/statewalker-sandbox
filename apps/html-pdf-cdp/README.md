# html-pdf-cdp

> **Prototype.** Private, unpublished, APIs may change.

Prints an HTML page to PDF over the **Chrome DevTools Protocol**, with no Puppeteer in between, on
**Cloudflare Browser Run's Kitesurf engine** or on any CDP browser (Browser Run's Chromium, a
local Chromium). The same client and the same calls are used for every engine.

```sh
pnpm --filter @statewalker/html-pdf-cdp test                    # local Chromium (+ Browser Run with credentials)
pnpm --filter @statewalker/html-pdf-cdp print page.html out.pdf # local headless Chromium
CF_ACCOUNT_ID=… CF_API_TOKEN=… pnpm --filter @statewalker/html-pdf-cdp print page.html out.pdf --kitesurf
```

`--browser-run` uses Browser Run's default Chromium engine, `--endpoint ws://…` any CDP endpoint;
`--load dataUrl`, `--landscape`, `--no-background`, `--css-page-size`, `--stream` as below.

## How it prints

`src/print.ts`, plain CDP over one WebSocket (`src/cdp.ts`):

1. `Target.createTarget` (about:blank) and `Target.attachToTarget` with `flatten: true`.
2. The HTML goes in with `Page.setDocumentContent`. If the engine does not implement it (a CDP
   "method not found" answer, not a lost session), the page navigates to a percent-encoded
   `data:text/html,…` URL and waits for `Page.loadEventFired`; a page over Chromium's 2 MB URL
   limit is written into about:blank with `document.write` instead.
3. Web fonts and images are awaited with `Runtime.evaluate` (`document.fonts.ready`, image
   `decode()`, lazy images made eager), best effort and at most 10 s: an engine that refuses, or
   a resource that never arrives, is printed as is, and the result says so.
4. `Page.printToPDF` (A4 and backgrounds by default; CSS `@page` size with `preferCSSPageSize`),
   returned base64, or with `stream` as an IO stream read in 1 MiB parts (`IO.read`).
5. `Target.closeTarget`, whatever happened.

## Kitesurf

Kitesurf is Browser Run's agent-first browser engine: it runs in V8 isolates on Cloudflare's
network instead of a Chromium container, does real layout (Stylo CSS, Blitz painting), and
implements **a subset of CDP**. Per Cloudflare's docs (Nov 2026):

- It is selected with `browser=kitesurf` on Browser Run's browser-level CDP endpoint,
  `wss://api.cloudflare.com/client/v4/accounts/<ACCOUNT_ID>/browser-run/devtools/browser?browser=kitesurf`,
  with `Authorization: Bearer <API token with Browser Run: Edit>` (`browserRunEndpoint` in
  `src/endpoints.ts`). It does not take `keep_alive`, `lab` or `recording`.
- From a Worker it is documented only for **Quick Actions**:
  `env.BROWSER.quickAction("pdf", { html, browser: "kitesurf", pdfOptions })`. The binding's
  `launch`/`acquire` (the CDP route) has no engine option.
- **It is not available locally**: `wrangler dev` throws for `browser: "kitesurf"` (use a remote
  binding), and the engine's open-source release could not be reached from here.
- Its output is "not pixel-perfect", and whether `Page.printToPDF` is in its CDP subset is not
  documented, hence the fallbacks above and the looser checks in its test (the words must be in
  the PDF; page count, fonts and A4 size are checked for Chromium only).

## Tested

| Engine | Result |
| --- | --- |
| Local Chromium 153 (headless) | 2 A4 pages, text with accents, table cells, bold font, the SVG chart as vectors; setDocumentContent, data: URL, document.write (1.7 MB page) and streamed routes alike; an image that never loads still prints; ≈ 120 ms |
| Browser Run, Kitesurf | **not run**: needs a Cloudflare account id and API token (`CF_ACCOUNT_ID`, `CF_API_TOKEN`); the test is skipped without them |
| Browser Run, Chromium | **not run**, same reason |

Sources: [Kitesurf](https://developers.cloudflare.com/browser-run/kitesurf/),
[Browser Run CDP](https://developers.cloudflare.com/browser-run/cdp/),
[PDF quick action](https://developers.cloudflare.com/browser-run/quick-actions/pdf-endpoint/),
[Introducing Kitesurf](https://blog.cloudflare.com/kitesurf/),
[A Kitesurf update](https://blog.cloudflare.com/kitesurf-update).
