/**
 * `bun run main.ts [--port 9090] [--origin https://tools.sandclaw.ai] [--open] [--no-cookie-jars]`
 *
 * Starts the Bridge on 127.0.0.1 and prints the PeerShare URL that pairs the
 * page with it; `--open` also opens that URL in the default browser (rung 14).
 */

import { spawn } from "node:child_process";
import { parseArgs } from "node:util";
import { createBridge } from "@statewalker/httpeers-share/bridge";

interface BunServer {
  port: number;
}
declare const Bun: {
  serve(init: {
    hostname: string;
    port: number;
    fetch: (request: Request) => Promise<Response>;
  }): BunServer;
};

const { values } = parseArgs({
  options: {
    port: { type: "string", default: "9090" },
    origin: { type: "string", default: "https://tools.sandclaw.ai" },
    open: { type: "boolean", default: false },
    // Each Guest's cookies kept apart, so cookie logins work for Guests (rung 16, M9).
    "no-cookie-jars": { type: "boolean", default: false },
  },
});

// 32 random bytes: the Pairing token, new on every launch, never stored.
const token = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
const origin = values.origin;

const server = Bun.serve({
  // IPv4 loopback only. The printed URL says 127.0.0.1, never `localhost`,
  // which a browser may try as ::1 first and find nothing there.
  hostname: "127.0.0.1",
  port: Number(values.port),
  fetch: createBridge({ token, allowedOrigin: origin, cookieJars: !values["no-cookie-jars"] }),
});

const localUrl = `http://127.0.0.1:${server.port}`;
const pairing = new URLSearchParams({ localUrl, t: token });
console.log(`PeerShare Bridge listening on ${localUrl}`);
console.log("Open this page to share your local services:");
console.log(`${origin}/peer-share#${pairing}`);

if (values.open) openInBrowser(`${origin}/peer-share#${pairing}`);

/** The platform's opener; `PEERSHARE_OPEN` overrides it (tests, unusual desktops). */
function openInBrowser(url: string): void {
  const opener =
    process.env.PEERSHARE_OPEN ??
    (process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "explorer"
        : "xdg-open");
  spawn(opener, [url], { stdio: "ignore", detached: true }).on("error", () => {
    console.log("Could not open a browser; open the link above yourself.");
  });
}
