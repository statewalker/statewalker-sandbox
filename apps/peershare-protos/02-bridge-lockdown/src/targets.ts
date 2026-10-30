/**
 * Where the Bridge may relay: the Sharer's own machine and LAN, nothing else.
 *
 * Only literal addresses and `localhost` are accepted. A DNS name is decided
 * by whoever controls its zone at request time (DNS rebinding), so "only
 * private names" cannot be checked before connecting; an address can.
 */

export function isAllowedTarget(target: string): boolean {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;

  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost") return true;

  const v4 = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (v4 != null) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }

  if (host.includes(":")) {
    // Loopback, and unique-local fc00::/7. Link-local and IPv4-mapped are refused.
    return host === "::1" || /^f[cd][0-9a-f]{0,2}:/.test(host);
  }

  return false;
}
