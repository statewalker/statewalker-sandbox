/**
 * M8 — the deployment (deploy/peershare) brought up with Docker Compose and
 * driven through the same scenario, under real host names:
 *
 *   https://peershare.localhost:<port>   the page, from Caddy
 *   https://<name>.p.localhost:<port>    the session zone, from the same Caddy
 *
 * One wildcard certificate, trusted by its SPKI hash. The relay runs on the
 * host (httpeers' relay image is the production one; the registry is not
 * reachable from every machine). Skipped without a Docker daemon.
 */

import { execFileSync } from "node:child_process";
import { createHash, createPublicKey } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { get } from "node:https";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createBridge, type Listening, listenLoopback } from "@statewalker/httpeers-share/bridge";
import { type Browser, chromium } from "playwright";
import { afterAll, beforeAll, describe, it } from "vitest";
import { startRelay } from "./e2e-harness.js";
import { dirkSharesClaudiaViews, startDirksApp } from "./scenario.js";

const DEPLOY = resolve(import.meta.dirname, "../../../deploy/peershare");
const PORT = "18443";
const PAGE = `https://peershare.localhost:${PORT}`;
const TOKEN = "peershare-deploy";

const hasDocker = (() => {
  try {
    execFileSync("docker", ["info"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

let env: NodeJS.ProcessEnv;
let spki: string;
let app: Awaited<ReturnType<typeof startDirksApp>>;
let relay: Awaited<ReturnType<typeof startRelay>>;
let bridge: Listening;
let browser: Browser;

function compose(...args: string[]) {
  execFileSync("docker", ["compose", ...args], { cwd: DEPLOY, env, stdio: "inherit" });
}

/** Caddy answers https on the page host (any status: it is up). */
async function caddyUp(): Promise<void> {
  for (let i = 0; i < 60; i++) {
    const ok = await new Promise<boolean>((done) =>
      get(
        {
          host: "127.0.0.1",
          port: Number(PORT),
          path: "/peershare.json",
          servername: "peershare.localhost",
          headers: { host: `peershare.localhost:${PORT}` },
          rejectUnauthorized: false,
        },
        (res) => {
          res.resume();
          done(res.statusCode === 200);
        },
      ).on("error", () => done(false)),
    );
    if (ok) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("Caddy did not come up");
}

beforeAll(async () => {
  if (!hasDocker) return;
  const certs = mkdtempSync(join(tmpdir(), "peershare-deploy-"));
  execFileSync(
    "openssl",
    [
      ...["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1"],
      ...["-keyout", join(certs, "key.pem"), "-out", join(certs, "cert.pem")],
      ...["-subj", "/CN=peershare.localhost"],
      ...["-addext", "subjectAltName=DNS:peershare.localhost,DNS:*.p.localhost"],
    ],
    { stdio: "ignore" },
  );
  execFileSync("chmod", ["-R", "a+rX", certs]);
  spki = createHash("sha256")
    .update(
      createPublicKey(readFileSync(join(certs, "key.pem"))).export({ type: "spki", format: "der" }),
    )
    .digest("base64");

  relay = await startRelay();
  env = {
    ...process.env,
    PAGE_HOST: "peershare.localhost",
    PARENT_ZONE: "localhost",
    SESSION_ZONE: "p.localhost",
    HTTPS_PORT: PORT,
    HTTP_PORT: "18080",
    RELAY_ADDRS: relay.addr,
    DEV: "true",
    TLS: "/certs/cert.pem /certs/key.pem",
    CERTS_DIR: certs,
  };
  execFileSync("node", [join(DEPLOY, "build.mjs")], { env, stdio: "inherit" });
  compose("up", "-d", "--wait");
  await caddyUp();

  app = await startDirksApp();
  bridge = await listenLoopback(
    createBridge({ token: TOKEN, allowedOrigin: PAGE, cookieJars: true }),
  );
  browser = await chromium.launch({ args: [`--ignore-certificate-errors-spki-list=${spki}`] });
}, 300_000);
afterAll(async () => {
  await browser?.close();
  await bridge?.close();
  await app?.close();
  await relay?.stop();
  if (hasDocker && env != null) compose("down", "-v");
});

describe.skipIf(!hasDocker)("M8 — the deployment, under Docker Compose", () => {
  it("serves the page and the session zone; the whole scenario works through it", async () => {
    await dirkSharesClaudiaViews({
      browser,
      pageOrigin: PAGE,
      bridge: { origin: bridge.origin, token: TOKEN },
      appOrigin: app.origin,
      sessionUrl: /^https:\/\/[a-z0-9]+\.p\.localhost:18443\//,
    });
  });
});
