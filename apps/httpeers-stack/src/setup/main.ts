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
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DEFAULT_HUB_KEY_PATH } from "../hub/main.js";
import { DEFAULT_RELAY_KEY_PATH, DEFAULT_RELAY_PORT } from "../relay/main.js";
import { loadOrGenerateKey, peerIdOf } from "./keys.js";

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
  /** Defaults to `DEFAULT_RELAY_HOST` ("127.0.0.1"). The host peers dial the relay at -- not necessarily where the relay binds (that is always `0.0.0.0`, see `relay/main.ts`). */
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
    relayAddrs: [`/ip4/${host}/tcp/${port}/${scheme}/p2p/${relayPeerId}`],
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
