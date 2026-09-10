/**
 * Turning "which relay?" into "which addresses?".
 *
 * The deployed relay publishes a bootstrap document at
 * `/.well-known/httpeers-relay.json`:
 *
 *     { "relayAddrs": ["/dns4/relay.httpeers.net/tcp/443/tls/ws/p2p/12D3Koo…"] }
 *
 * so a peer is configured with **one value it already knows** — the relay's
 * URL — instead of a multiaddr somebody had to copy out of a deployment log.
 * That matters more than it looks: the relay's peer id is not in any repo and
 * not derivable from the hostname, so before this document existed the only
 * way to obtain it was out-of-band, and a stale copy fails as a dial timeout
 * that names nothing useful.
 *
 * THE PEER ID IS THE POINT, NOT THE CONVENIENCE. `relayAddrs` entries each
 * carry exactly one `/p2p/<id>`, and that id is what the client pins and what
 * Noise verifies once the connection is up. An address without one would
 * still dial and would authenticate nothing — so `assertPinnable` below
 * rejects it rather than letting a weaker connection look like a working one.
 * This mirrors `assertBootstrapAddr` on the relay side; the two are inverses
 * of the relay's own announce check, which requires the opposite (libp2p
 * appends the peer id itself when announcing).
 *
 * FETCHING THIS FROM A BROWSER WORKS ONLY BECAUSE THE RELAY SETS CORS. The
 * document is served with `Access-Control-Allow-Origin: *` — deliberately, as
 * browser peers fetch it from their own origin and never from the relay's. If
 * that header is ever dropped, `curl` keeps working and every browser peer
 * stops, which is the failure this comment exists to make searchable.
 */

/** The document's shape. `relayAddrs` is the key `httpeers.json` already uses. */
export interface RelayDocument {
  relayAddrs: string[];
}

/** Where the document lives, relative to the relay's origin. */
export const RELAY_DOCUMENT_PATH = "/.well-known/httpeers-relay.json";

/**
 * Accepts either form and returns dialable addresses:
 *
 * - a multiaddr (`/dns4/…` or `/ip4/…`) — used as-is, one address
 * - an http(s) URL — the bootstrap document is fetched from its origin
 *
 * The multiaddr form is kept for local development, where the relay is a
 * process on loopback with no document and no Caddy in front of it.
 *
 * NOTE the document path is absolute, so a path in the URL is silently
 * ignored: `https://host/some/prefix` fetches `https://host/.well-known/…`.
 */
export async function resolveRelayAddrs(relay: string): Promise<string[]> {
  if (relay.startsWith("/")) {
    return [relay];
  }

  const url = new URL(RELAY_DOCUMENT_PATH, relay).toString();

  let response: Response;
  try {
    response = await fetch(url);
  } catch (cause) {
    // In a browser this is where a missing CORS header lands, and the
    // platform's own message ("Failed to fetch") says nothing about why.
    throw new Error(
      `could not fetch the relay's bootstrap document at ${url}: ${(cause as Error).message}. ` +
        "From a browser, check that the relay serves it with Access-Control-Allow-Origin.",
      { cause },
    );
  }

  if (!response.ok) {
    // A relay that cannot start clears its document rather than leaving a
    // stale one, so 404 means "the relay is down", not "wrong URL".
    throw new Error(
      `the relay's bootstrap document at ${url} returned ${response.status}. ` +
        "A 404 means the relay is not running: it clears the document rather than " +
        "leaving a stale one Caddy would keep serving.",
    );
  }

  const document = (await response.json()) as Partial<RelayDocument>;
  const addrs = document.relayAddrs;

  if (!Array.isArray(addrs) || addrs.length === 0) {
    throw new Error(
      `the relay's bootstrap document at ${url} lists no addresses. ` +
        "Parsing it happily and concluding the relay has no address is worse than " +
        "an error, so this is one.",
    );
  }

  for (const addr of addrs) assertPinnable(addr, url);
  return addrs;
}

/**
 * Rejects a published address a client could not pin.
 *
 * Exactly one `/p2p/` is required. None means the peer id is missing, and the
 * connection would authenticate nothing. Two means an announce address was
 * hand-written carrying a peer id that libp2p then appended to again — a
 * misconfiguration on the relay that produces an address which parses and
 * never dials.
 */
export function assertPinnable(addr: string, source: string): void {
  if (typeof addr !== "string" || !addr.startsWith("/")) {
    throw new Error(`${source} published "${String(addr)}", which is not a multiaddr.`);
  }
  const count = addr.split("/p2p/").length - 1;
  if (count !== 1) {
    throw new Error(
      `${source} published "${addr}" with ${count} /p2p/ components; exactly one is required. ` +
        "The peer id is what the client pins and what Noise verifies afterwards.",
    );
  }
}
