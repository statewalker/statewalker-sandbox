/**
 * `pnpm setup`: turns a fresh checkout into a runnable stack by generating
 * (or, on a later run, simply reading back) this deployment's persistent
 * identity, and writing `httpeers.json` -- the invitation payload.
 *
 * ONE SHAPE, TWO DELIVERY CHANNELS (design note 07 §4). `httpeers.json` is
 * `{ relayAddrs, hubPeerId }`: the daemons (`../relay/main.ts`,
 * `../hub/main.ts`) read it from disk because an operator installed them;
 * the browser pages fetch it over HTTP (`../static-server/main.ts` already
 * serves it, with a distinct 503 when it is missing) because a browser
 * cannot read a file. This module is the one writer of that file -- both
 * consumers only ever read it.
 *
 * IDEMPOTENT BY CONSTRUCTION, not by a special case here: `runSetup` does
 * nothing but call `keys.ts`'s `loadOrGenerateKey` (which never rewrites an
 * existing key file -- see that module's comment) and then re-derive
 * `httpeers.json` from whatever keys/env came back. Running this twice with
 * the same env produces byte-identical output both times; running it twice
 * with DIFFERENT `RELAY_HOST`/`RELAY_PORT`/TLS env still reuses the same
 * keys and only the config's addresses change -- the mesh identity itself
 * never moves.
 *
 * ADDRESS FAMILY MATTERS FOR TLS, NOT JUST COSMETICALLY. A browser cannot
 * dial a bare IP literal over TLS -- the certificate will not match it --
 * so a server deployment's `wss` relay address MUST be built as
 * `/dns4/<host>/...`, never `/ip4/<host>/...`, or it is undialable from the
 * very peers the deployment exists to serve (design note's local-vs-server
 * table: `/ip4/0.0.0.0/tcp/9090/ws` locally, `/dns4/host/tcp/443/wss` on a
 * server, same env/cert). `relayAddrFamily` below is the one place that
 * decides this, via `node:net`'s own `isIP` -- not a general address-
 * parsing layer, just the one branch this invitation payload needs.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { isIP } from "node:net";
import { dirname, resolve } from "node:path";
import { DEFAULT_HUB_KEY_PATH } from "../hub/main.js";
import { DEFAULT_RELAY_KEY_PATH, DEFAULT_RELAY_PORT } from "../relay/main.js";
import { loadOrGenerateKey, peerIdOf } from "./keys.js";

/**
 * The multiaddr protocol segment for `host`: `ip4`/`ip6` for an IP literal
 * (`node:net`'s `isIP` -- 4 or 6), `dns4` for anything else (a hostname).
 * `dns4` rather than a bare `dns` because every consumer here dials over
 * IPv4-resolving infrastructure (matches the design record's own
 * `/dns4/host/tcp/443/wss` example) -- if a deployment ever needs `dns6`,
 * that is a real, separate decision, not implied by this function's name.
 */
function relayAddrFamily(host: string): "ip4" | "ip6" | "dns4" {
  switch (isIP(host)) {
    case 4:
      return "ip4";
    case 6:
      return "ip6";
    default:
      return "dns4";
  }
}

/** Where `pnpm setup` writes the invitation payload -- matches `../static-server/main.ts`'s `DEFAULT_HTTPEERS_CONFIG_PATH`. */
export const DEFAULT_CONFIG_PATH = "./httpeers.json";
/** `RELAY_HOST`'s default -- a loopback dial address for local/dev runs, matching the design record's own example. */
export const DEFAULT_RELAY_HOST = "127.0.0.1";

/** The invitation payload's shape -- design note 07 §4. */
export interface HttpeersConfig {
  relayAddrs: string[];
  hubPeerId: string;
}

export interface SetupInit {
  /** Defaults to `DEFAULT_RELAY_KEY_PATH` (`../relay/main.ts`'s own default -- the same path it reads back). */
  relayKeyPath?: string;
  /** Defaults to `DEFAULT_HUB_KEY_PATH`. */
  hubKeyPath?: string;
  /** Defaults to `DEFAULT_CONFIG_PATH`. */
  configPath?: string;
  /**
   * Defaults to `DEFAULT_RELAY_HOST` ("127.0.0.1"). The host peers dial the
   * relay at -- not necessarily where the relay binds (that is always
   * `0.0.0.0`, see `relay/main.ts`). May be an IPv4/IPv6 literal or a
   * hostname; `relayAddrFamily` picks the right multiaddr protocol segment
   * for whichever is given (see the module comment's "ADDRESS FAMILY"
   * note) -- callers never need to say which kind of host this is.
   */
  relayHost?: string;
  /** Defaults to `DEFAULT_RELAY_PORT` (9090). */
  relayPort?: number;
  /** When true, `relayAddrs` use the `wss` scheme instead of `ws` -- matches a relay run with `TLS_CERT`/`TLS_KEY` set. */
  relayTls?: boolean;
  /** See `keys.ts`'s `LoadOrGenerateKeyInit.seed`. */
  relaySeed?: string;
  /** See `keys.ts`'s `LoadOrGenerateKeyInit.seed`. */
  hubSeed?: string;
}

export interface SetupResult {
  relayPeerId: string;
  hubPeerId: string;
  relayKeyPath: string;
  hubKeyPath: string;
  configPath: string;
  config: HttpeersConfig;
}

export async function runSetup(init: SetupInit = {}): Promise<SetupResult> {
  const relayKeyPath = init.relayKeyPath ?? DEFAULT_RELAY_KEY_PATH;
  const hubKeyPath = init.hubKeyPath ?? DEFAULT_HUB_KEY_PATH;
  const configPath = init.configPath ?? DEFAULT_CONFIG_PATH;

  const relayKey = await loadOrGenerateKey({ keyPath: relayKeyPath, seed: init.relaySeed });
  const hubKey = await loadOrGenerateKey({ keyPath: hubKeyPath, seed: init.hubSeed });

  const relayPeerId = peerIdOf(relayKey);
  const hubPeerId = peerIdOf(hubKey);

  const scheme = init.relayTls ? "wss" : "ws";
  const host = init.relayHost ?? DEFAULT_RELAY_HOST;
  const port = init.relayPort ?? DEFAULT_RELAY_PORT;

  const config: HttpeersConfig = {
    relayAddrs: [`/${relayAddrFamily(host)}/${host}/tcp/${port}/${scheme}/p2p/${relayPeerId}`],
    hubPeerId,
  };

  mkdirSync(dirname(resolve(configPath)), { recursive: true });
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);

  return { relayPeerId, hubPeerId, relayKeyPath, hubKeyPath, configPath, config };
}

// Run directly (e.g. `tsx src/setup/main.ts`) rather than only as a library import.
if (import.meta.url === `file://${process.argv[1]}`) {
  const result = await runSetup({
    relayHost: process.env.RELAY_HOST,
    relayPort: process.env.RELAY_PORT != null ? Number(process.env.RELAY_PORT) : undefined,
    relayTls: process.env.TLS_CERT != null && process.env.TLS_KEY != null,
    relaySeed: process.env.RELAY_SEED,
    hubSeed: process.env.HUB_SEED,
  });

  console.log("setup: relay key  ->", result.relayKeyPath);
  console.log("setup: hub key    ->", result.hubKeyPath);
  console.log("setup: relay peerId:", result.relayPeerId);
  console.log("setup: hub peerId:  ", result.hubPeerId);
  console.log("setup: wrote", result.configPath);
  console.log(JSON.stringify(result.config, null, 2));
}
