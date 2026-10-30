import { checkServiceTarget, type TargetRefusal } from "@statewalker/httpeers-share";
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

  const host = new URL(target).hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "0.0.0.0") return refuse("Use localhost or the machine's own address, not 0.0.0.0.");
  // The rule itself is httpeers-share's (decision 4.1), the one the logic applies.
  if (checkServiceTarget("bridged", target).ok) return { ok: true, kind: "bridged", target };
  const direct = checkServiceTarget("direct", target);
  if (direct.ok) return { ok: true, kind: "direct", target };
  return refuse(TARGET_REFUSALS[direct.reason] ?? "PeerShare cannot share this address.");
}

const TARGET_REFUSALS: Partial<Record<TargetRefusal, string>> = {
  "needs-domain-name": "Use the service's domain name, not an IP address.",
  "needs-https": "A remote service must use https://.",
  "not-http": "Start the address with http:// or https://.",
  "not-a-url": "Start the address with http:// or https://.",
};
