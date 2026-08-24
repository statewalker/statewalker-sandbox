/**
 * `pnpm bootstrap`: turns a fresh checkout into a runnable stack by generating
 * (or, on a later run, simply reading back) this deployment's persistent
 * identity, and writing `httpeers.json` -- the invitation payload.
 *
 * ONE SHAPE, TWO DELIVERY CHANNELS (design note 07 §4). `httpeers.json` is
 * `{ relayAddrs: [{ addr, subnetwork }], hubPeerId }`: the daemons (`@statewalker/httpeers-relay`,
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
 * A SUBNETWORK NAME IS PART OF THAT PAYLOAD NOW, and it is generated rather
 * than defaulted. The relay refuses any peer that announces no name, so this
 * file is where this deployment gets one -- see `loadOrGenerateSubnetwork`
 * for why a second run keeps the first run's name, and
 * `generateSubnetworkName` for why it is random rather than "dev".
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

import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isIP } from "node:net";
import { dirname, resolve } from "node:path";
import { DEFAULT_RELAY_KEY_PATH, DEFAULT_RELAY_PORT } from "@statewalker/httpeers-relay";
import { subnetworkNameProblem } from "@statewalker/httpeers-relay/subnetwork";
import { DEFAULT_HUB_KEY_PATH } from "../hub/main.js";
import type { RelayEntry } from "../reservation.js";
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

/** Where `pnpm bootstrap` writes the invitation payload -- matches `../static-server/main.ts`'s `DEFAULT_HTTPEERS_CONFIG_PATH`. */
export const DEFAULT_CONFIG_PATH = "./httpeers.json";
/** `RELAY_HOST`'s default -- a loopback dial address for local/dev runs, matching the design record's own example. */
export const DEFAULT_RELAY_HOST = "127.0.0.1";

/**
 * The invitation payload's shape -- design note 07 §4.
 *
 * `relayAddrs` CARRIES `{ addr, subnetwork }`, NOT A BARE STRING, and that is
 * a breaking change from every `httpeers.json` written before it. The
 * subnetwork name attaches to the RELAY ENTRY rather than to the mesh,
 * because a subnetwork is a property of reachability through one relay --
 * which is what lets a mesh span more than one subnetwork later without a
 * second migration to this file.
 */
export interface HttpeersConfig {
  relayAddrs: RelayEntry[];
  hubPeerId: string;
}

/**
 * How many random bytes a generated subnetwork name carries. 12 bytes is 96
 * bits, rendered as 24 hex characters -- short enough to read back over a
 * phone or fit in a QR code, long enough that nobody arrives at it by
 * guessing.
 */
const SUBNETWORK_RANDOM_BYTES = 12;

/**
 * A fresh subnetwork name.
 *
 * RANDOM BY DEFAULT, AND THE REASON IS COLLISION RATHER THAN ATTACK. `dev`,
 * `test`, `home` and `demo` are what people type, and two unrelated groups
 * running this stack against one shared relay would find each other by
 * accident -- each seeing the other's peers in its mesh view, each unable to
 * explain it. A random name makes that not happen.
 *
 * SAY WHAT IT DOES AND DOES NOT BUY. An unguessable name will be used as
 * light privacy, because it behaves like one. It keeps strangers from
 * stumbling in; it does not survive being shared, screenshotted, logged or
 * put in a QR code, and the relay's operator sees every name regardless. It
 * is not a key, a secret or a credential, and nothing may treat it as one.
 */
export function generateSubnetworkName(): string {
  return randomBytes(SUBNETWORK_RANDOM_BYTES).toString("hex");
}

/**
 * The subnetwork this deployment uses: `override` if given, the one already
 * in `configPath` if there is one, a fresh random name otherwise.
 *
 * READING THE EXISTING FILE BACK IS WHAT KEEPS `pnpm bootstrap` IDEMPOTENT,
 * exactly as `keys.ts`'s `loadOrGenerateKey` does for the identities. A
 * second run that minted a new name would move this deployment into a
 * different subnetwork while every page's remembered mesh, every printed join
 * URL and every QR code still named the old one -- and the symptom (peers can
 * no longer reach each other) points nowhere near a bootstrap that "did
 * nothing".
 */
export function loadOrGenerateSubnetwork(configPath: string, override?: string): string {
  if (override != null && override.trim() !== "") {
    const name = override.trim();
    const problem = subnetworkNameProblem(name);
    if (problem != null) {
      throw new Error(`setup: RELAY_SUBNETWORK="${name}" is not usable -- ${problem}.`);
    }
    return name;
  }

  try {
    const existing = JSON.parse(readFileSync(configPath, "utf8")) as Partial<HttpeersConfig>;
    const held = existing.relayAddrs?.[0]?.subnetwork;
    if (typeof held === "string" && subnetworkNameProblem(held) === null) return held;
  } catch {
    // No file, unreadable file, or a file written before subnetworks existed
    // -- all of them mean "there is no name to keep", and a fresh one follows.
  }
  return generateSubnetworkName();
}

export interface SetupInit {
  /** Defaults to `DEFAULT_RELAY_KEY_PATH` (`@statewalker/httpeers-relay`'s own default -- the same path it reads back). */
  relayKeyPath?: string;
  /** Defaults to `DEFAULT_HUB_KEY_PATH`. */
  hubKeyPath?: string;
  /** Defaults to `DEFAULT_CONFIG_PATH`. */
  configPath?: string;
  /**
   * Defaults to `DEFAULT_RELAY_HOST` ("127.0.0.1"). The host peers dial the
   * relay at -- not necessarily where the relay binds (that is always
   * `0.0.0.0`, see `@statewalker/httpeers-relay`). May be an IPv4/IPv6 literal or a
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
  /**
   * The subnetwork name this deployment announces to the relay. Defaults to
   * whatever `configPath` already holds, and to a fresh random name when it
   * holds none -- see `loadOrGenerateSubnetwork`.
   */
  subnetwork?: string;
}

export interface SetupResult {
  relayPeerId: string;
  hubPeerId: string;
  /** The subnetwork name written into `httpeers.json` -- generated, kept from the previous run, or overridden. */
  subnetwork: string;
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
  const subnetwork = loadOrGenerateSubnetwork(configPath, init.subnetwork);

  const config: HttpeersConfig = {
    relayAddrs: [
      {
        addr: `/${relayAddrFamily(host)}/${host}/tcp/${port}/${scheme}/p2p/${relayPeerId}`,
        subnetwork,
      },
    ],
    hubPeerId,
  };

  mkdirSync(dirname(resolve(configPath)), { recursive: true });
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);

  return { relayPeerId, hubPeerId, subnetwork, relayKeyPath, hubKeyPath, configPath, config };
}

// Run directly (e.g. `tsx src/setup/main.ts`) rather than only as a library import.
if (import.meta.url === `file://${process.argv[1]}`) {
  const result = await runSetup({
    relayHost: process.env.RELAY_HOST,
    relayPort: process.env.RELAY_PORT != null ? Number(process.env.RELAY_PORT) : undefined,
    relayTls: process.env.TLS_CERT != null && process.env.TLS_KEY != null,
    relaySeed: process.env.RELAY_SEED,
    hubSeed: process.env.HUB_SEED,
    subnetwork: process.env.RELAY_SUBNETWORK,
  });

  console.log("setup: relay key  ->", result.relayKeyPath);
  console.log("setup: hub key    ->", result.hubKeyPath);
  console.log("setup: relay peerId:", result.relayPeerId);
  console.log("setup: hub peerId:  ", result.hubPeerId);
  console.log("setup: subnetwork:  ", result.subnetwork);
  console.log(
    "setup: that name is how this deployment's peers find each other through the relay. It is",
  );
  console.log(
    "setup: not a key or a secret: it keeps unrelated groups on a shared relay from colliding,",
  );
  console.log("setup: and it does not make this mesh private. Override it with RELAY_SUBNETWORK.");
  console.log("setup: wrote", result.configPath);
  console.log(JSON.stringify(result.config, null, 2));
}
