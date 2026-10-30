/**
 * `bun run main.ts [--port 9090] [--origin https://tools.sandclaw.ai]`
 *
 * Starts the Bridge on 127.0.0.1 and prints the PeerShare URL that pairs the
 * page with it. Opening the browser is rung 14's (with the compiled binary).
 */

import { parseArgs } from "node:util";
import { createBridge } from "./bridge.js";

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
  fetch: createBridge({ token, allowedOrigin: origin }),
});

const localUrl = `http://127.0.0.1:${server.port}`;
const pairing = new URLSearchParams({ localUrl, t: token });
console.log(`PeerShare Bridge listening on ${localUrl}`);
console.log("Open this page to share your local services:");
console.log(`${origin}/peer-share#${pairing}`);
