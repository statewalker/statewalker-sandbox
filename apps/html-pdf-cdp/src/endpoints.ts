/**
 * Where the CDP browser is:
 *   - Kitesurf: Cloudflare Browser Run's browser-level CDP endpoint with `browser=kitesurf`,
 *     authenticated with an API token (Browser Run: Edit). It runs on Cloudflare only.
 *   - Browser Run's default (Chromium) engine: the same endpoint without `browser`.
 *   - A local Chromium started with --remote-debugging-port, for development and tests.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CdpEndpoint } from "./cdp.ts";

export type BrowserRunCredentials = { accountId: string; apiToken: string };

/** Browser Run's CDP endpoint; `browser: "kitesurf"` selects the Kitesurf engine. */
export function browserRunEndpoint(
  { accountId, apiToken }: BrowserRunCredentials,
  { browser }: { browser?: "kitesurf" } = {},
): CdpEndpoint {
  if (!/^[0-9a-f]{32}$/.test(accountId)) throw new Error("EINVAL: account id is 32 hex digits");
  const url = new URL(
    `wss://api.cloudflare.com/client/v4/accounts/${accountId}/browser-run/devtools/browser`,
  );
  // Kitesurf does not take keep_alive, lab or recording (Browser Run CDP reference).
  if (browser) url.searchParams.set("browser", browser);
  return { url: url.toString(), headers: { Authorization: `Bearer ${apiToken}` } };
}

/** Credentials from CF_ACCOUNT_ID and CF_API_TOKEN, or null when either is missing. */
export function credentialsFromEnv(env = process.env): BrowserRunCredentials | null {
  const accountId = env.CF_ACCOUNT_ID;
  const apiToken = env.CF_API_TOKEN;
  return accountId && apiToken ? { accountId, apiToken } : null;
}

const CHROMIUM_CANDIDATES = [
  process.env.CHROMIUM_PATH,
  "/opt/pw-browsers/chromium/chrome-linux64/chrome",
  "/opt/pw-browsers/chromium-1243/chrome-linux64/chrome",
  "/usr/bin/chromium",
  "/usr/bin/google-chrome",
];

/** Starts a headless Chromium with CDP on a free port; `close` stops it and removes its profile. */
export async function launchLocalChromium(): Promise<{
  endpoint: CdpEndpoint;
  version: string;
  close: () => Promise<void>;
}> {
  const bin = CHROMIUM_CANDIDATES.find((p) => p && existsSync(p));
  if (!bin) throw new Error("ENOENT: no Chromium found (set CHROMIUM_PATH)");
  const profile = mkdtempSync(join(tmpdir(), "html-pdf-cdp-"));
  const child = spawn(
    bin,
    [
      "--headless",
      "--no-sandbox",
      "--disable-gpu",
      "--no-first-run",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  let log = "";
  const url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`ETIMEDOUT: Chromium did not start\n${log}`)),
      30_000,
    );
    child.stderr.on("data", (d) => {
      log += d;
      const m = log.match(/DevTools listening on (ws:\/\/\S+)/);
      if (m) {
        clearTimeout(timer);
        resolve(m[1]);
      }
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`EIO: Chromium exited (${code})\n${log}`));
    });
  });
  const http = url.replace(/^ws:/, "http:").replace(/\/devtools\/.*$/, "");
  const version = ((await (await fetch(`${http}/json/version`)).json()) as { Browser: string })
    .Browser;
  return {
    endpoint: { url },
    version,
    close: async () => {
      if (child.exitCode === null) {
        const exited = new Promise((r) => child.once("exit", r));
        child.kill("SIGTERM");
        await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
        if (child.exitCode === null) child.kill("SIGKILL");
      }
      rmSync(profile, { recursive: true, force: true });
    },
  };
}
