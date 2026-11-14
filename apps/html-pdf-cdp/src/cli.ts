/**
 * Print an HTML file to PDF over CDP.
 *
 *   node --experimental-strip-types src/cli.ts page.html out.pdf [options]
 *
 *   --kitesurf            Cloudflare Browser Run, Kitesurf engine (CF_ACCOUNT_ID, CF_API_TOKEN)
 *   --browser-run         Cloudflare Browser Run, default (Chromium) engine (same variables)
 *   --endpoint ws://…     any CDP browser endpoint
 *   (none of these)       a local headless Chromium
 *   --load auto|setDocumentContent|dataUrl
 *   --landscape --no-background --css-page-size --stream
 */
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { CdpConnection, type CdpEndpoint, redact } from "./cdp.ts";
import { browserRunEndpoint, credentialsFromEnv, launchLocalChromium } from "./endpoints.ts";
import { printHtmlToPdf } from "./print.ts";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    kitesurf: { type: "boolean", default: false },
    "browser-run": { type: "boolean", default: false },
    endpoint: { type: "string" },
    load: { type: "string", default: "auto" },
    landscape: { type: "boolean", default: false },
    "no-background": { type: "boolean", default: false },
    "css-page-size": { type: "boolean", default: false },
    stream: { type: "boolean", default: false },
  },
});
const [input, output] = positionals;
if (!input || !output) {
  console.error("usage: cli.ts page.html out.pdf [--kitesurf|--browser-run|--endpoint ws://…]");
  process.exit(2);
}

let endpoint: CdpEndpoint;
let close = async () => {};
let label: string;
if (values.kitesurf || values["browser-run"]) {
  const creds = credentialsFromEnv();
  if (!creds) {
    console.error("set CF_ACCOUNT_ID and CF_API_TOKEN (a token with Browser Run: Edit)");
    process.exit(2);
  }
  endpoint = browserRunEndpoint(creds, values.kitesurf ? { browser: "kitesurf" } : {});
  label = values.kitesurf ? "Browser Run (Kitesurf)" : "Browser Run (Chromium)";
} else if (values.endpoint) {
  endpoint = { url: values.endpoint };
  label = redact(values.endpoint);
} else {
  const local = await launchLocalChromium();
  endpoint = local.endpoint;
  close = local.close;
  label = `local ${local.version}`;
}

let cdp: CdpConnection | undefined;
try {
  cdp = await CdpConnection.connect(endpoint);
  const result = await printHtmlToPdf(cdp, {
    html: readFileSync(input, "utf8"),
    load: values.load as "auto" | "setDocumentContent" | "dataUrl",
    stream: values.stream,
    pdf: {
      landscape: values.landscape,
      printBackground: !values["no-background"],
      preferCSSPageSize: values["css-page-size"],
    },
  });
  writeFileSync(output, result.pdf);
  console.log(
    `${output}: ${result.pdf.byteLength} bytes from ${label}; loaded with ${result.loadedWith}, ` +
      `resources ${result.awaitedResources ? "awaited" : "not awaited"}, ${result.timings.totalMs} ms`,
  );
} finally {
  cdp?.close();
  await close();
}
