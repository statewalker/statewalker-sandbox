/**
 * PeerShare's domain, as the screens see it. No React here.
 * Words as in `apps/peershare-protos/GLOSSARY.md`.
 */

export type UpstreamKind = "bridged" | "direct";
export type Health = "ok" | "slow" | "down" | "disabled" | "checking";
export type Warning = "ws-needed" | "cookies-set" | "cors-missing";

export interface Service {
  id: string;
  name: string;
  kind: UpstreamKind;
  target: string;
  enabled: boolean;
  isDefault: boolean;
  health: Health;
  warnings: Warning[];
}

export interface Guest {
  peerId: string;
  name: string;
  joinedAt: Date;
  online: boolean;
}

/** One link, for one Guest, once, within 24 hours. */
export interface Invite {
  url: string;
  expiresAt: Date;
  used: boolean;
}

export const INVITE_TTL_MS = 24 * 60 * 60 * 1000;

/** What the page learns about its Bridge (rung 03's `diagnoseBridge`). */
export type BridgeDiagnosis = "ok" | "permission-needed" | "bridge-not-running" | "token-rejected";

/** How the Sharer answers a Guest's Join or Decline. */
export type JoinOutcome =
  | "joined"
  | "machine-offline"
  | "invite-used"
  | "invite-expired"
  | "declined";

export interface ServiceDraft {
  name: string;
  target: string;
  isDefault: boolean;
}

export type DraftCheck =
  | { ok: true; kind: UpstreamKind; target: string }
  | { ok: false; errors: { name?: string; target?: string } };

/**
 * The v1 target policy, and which way the Service will be reached:
 * - **bridged** — this machine or its LAN (loopback, private and Tailscale
 *   addresses, `.local` names), through the Bridge, the CORS proxy on localhost;
 * - **direct** — a remote service on `https://` and a domain name, which must
 *   send CORS headers itself (only the Probe can tell whether it does).
 * The same addresses the Bridge accepts (rung 02), so the form never offers
 * what the Bridge would refuse.
 */
export function validateDraft(
  draft: ServiceDraft,
  services: readonly Service[],
  selfId?: string,
): DraftCheck {
  const name = draft.name.trim();
  if (name === "") return { ok: false, errors: { name: "Give it a name guests will recognise." } };
  const clash = services.some(
    (s) => s.id !== selfId && s.name.trim().toLowerCase() === name.toLowerCase(),
  );
  if (clash) return { ok: false, errors: { name: "Another service is already called that." } };

  const target = draft.target.trim();
  const refuse = (message: string): DraftCheck => ({ ok: false, errors: { target: message } });
  if (target === "") return refuse("Enter the service's address.");
  if (!/^https?:\/\//i.test(target) || !URL.canParse(target)) {
    return refuse("Start the address with http:// or https://.");
  }

  const url = new URL(target);
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "0.0.0.0") return refuse("Use localhost or the machine's own address, not 0.0.0.0.");
  if (host === "localhost" || host.endsWith(".local")) return { ok: true, kind: "bridged", target };
  if (isIpAddress(host)) {
    return isLocalAddress(host)
      ? { ok: true, kind: "bridged", target }
      : refuse("Use the service's domain name, not an IP address.");
  }
  if (url.protocol !== "https:") return refuse("A remote service must use https://.");
  return { ok: true, kind: "direct", target };
}

function isIpAddress(host: string): boolean {
  return /^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(":");
}

/** Loopback, RFC 1918, Tailscale (100.64/10), IPv6 loopback and unique-local: as the Bridge allows. */
function isLocalAddress(address: string): boolean {
  const v4 = address.match(/^(\d+)\.(\d+)\.\d+\.\d+$/);
  if (v4 != null) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return (
      a === 127 ||
      a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  return address === "::1" || /^f[cd][0-9a-f]{0,2}:/.test(address);
}
