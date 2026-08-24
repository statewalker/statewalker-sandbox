/**
 * `/httpeers/relay-net/1.0.0` -- the exchange in which a peer tells a relay
 * which subnetwork it belongs to, defined ONCE and shared by both ends.
 *
 * A SUBNETWORK IS A REACHABILITY DOMAIN, AND NOTHING ELSE. Peers sharing a
 * subnetwork name can dial each other through this relay; peers with
 * different names cannot. It contains one or more meshes and decides nothing
 * about membership.
 *
 * PARTITIONING IS NOT AUTHORISATION. A name stops strangers stumbling in and
 * stops cross-subnetwork dialling. It does NOT make a mesh secure or private
 * -- that is Noise proving identity and the hub deciding what a member may
 * do. The name is deliberately not called a key, a secret or a credential,
 * because it is none of those: it travels in invitations and QR codes, and
 * the relay operator sees every name regardless. It is unlisted, not
 * unlistenable.
 *
 * WHY THIS EXCHANGE HAS A REPLY AT ALL. Enforcement happens in the node's
 * connection gater -- `denyInboundRelayReservation` and
 * `denyOutboundRelayedConnection`, see `./subnetwork-registry.ts` -- and both
 * return a BOOLEAN. There is no reason channel: a peer refused there sees
 * only a reservation that did not happen. With a name now required of every
 * peer, "forgot to configure one" becomes the commonest failure and the least
 * legible one, so this exchange validates the announcement and ANSWERS it.
 * The gater is the enforcement point; this protocol is the explanation point.
 * The same lesson the token layer already learned the expensive way: an
 * opaque refusal sends a client into a retry loop with no signal.
 *
 * BROWSER-SAFE ON PURPOSE. This module imports types from `@libp2p/interface`
 * and nothing else -- no `node:*`, no relay server code -- because the client
 * half of it is bundled into browser pages (`apps/httpeers-stack`'s three
 * pages import it through `@statewalker/httpeers-relay/subnetwork`). The
 * relay-side registry lives next door in `./subnetwork-registry.ts`; keep it
 * there.
 */

import type { AbortOptions, Libp2p, PeerId, Stream } from "@libp2p/interface";

/**
 * The protocol id. Namespaced under `/httpeers/` like the mesh's own
 * `/httpeers/1.0.0`, and distinct from it: this one is spoken to the RELAY,
 * about reachability, and carries no membership claim of any kind.
 */
export const RELAY_NET_PROTOCOL = "/httpeers/relay-net/1.0.0";

/** The longest a subnetwork name may be. Long enough for 96 random bits in hex, short enough to read back over a phone. */
export const MAX_SUBNETWORK_NAME_LENGTH = 64;

/**
 * What a subnetwork name may contain: an alphanumeric first character, then
 * alphanumerics, dots, dashes and underscores.
 *
 * NARROW BY CHOICE. This value is written into `httpeers.json`, printed in
 * startup logs, put in invitations and encoded into QR codes, and it is
 * compared byte-for-byte on both sides of a partition. A charset with no
 * whitespace, no case-folding question and no percent-encoding question keeps
 * "the two names differ" meaning what it says.
 */
const SUBNETWORK_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Neither end will read more than this from the other. The whole exchange is two short JSON objects. */
export const MAX_RELAY_NET_MESSAGE_BYTES = 4096;

/** How long each side waits for the other's half of the exchange before giving up. */
export const RELAY_NET_TIMEOUT_MS = 10_000;

/**
 * Why the relay would not record an announcement. Carried as a code so a
 * caller can branch, alongside the human-readable text that is the point of
 * the reply existing.
 */
export type SubnetworkRefusalReason =
  /** The announcement carried no name. There is no default subnetwork -- a name is required. */
  | "no-subnetwork-name"
  /** The name is not a well-formed subnetwork name. See `SUBNETWORK_NAME_PATTERN`. */
  | "invalid-subnetwork-name"
  /** This relay runs in `registered` mode and the name is not on its list. */
  | "not-registered"
  /** The bytes on the wire were not a `/httpeers/relay-net/1.0.0` announcement. */
  | "malformed";

/** What a peer sends. One JSON object, then it closes its writing end. */
export interface SubnetworkAnnouncement {
  subnetwork: string;
}

/** What the relay answers with. */
export type SubnetworkAnnouncementReply =
  | { ok: true; subnetwork: string }
  | { ok: false; reason: SubnetworkRefusalReason; message: string };

/**
 * The relay refused this peer's announcement, and said why.
 *
 * WORTH ITS OWN TYPE because a page has to RENDER this rather than log it:
 * "no subnetwork name announced" is a configuration a person fixes, and it is
 * otherwise indistinguishable from the relay being down. `message` is the
 * relay's own words, already written for a human.
 */
export class SubnetworkRefusedError extends Error {
  override readonly name = "SubnetworkRefusedError";
  constructor(
    readonly reason: SubnetworkRefusalReason,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Is this a well-formed subnetwork name? Returns the complaint, or `null`
 * when the name is fine -- so one function serves the config loader (which
 * turns it into a `RelayConfigError`), the relay's handler (which turns it
 * into a reply) and the client (which refuses to announce nonsense before
 * opening a stream).
 */
export function subnetworkNameProblem(name: string): string | null {
  if (name === "") return "a subnetwork name cannot be empty";
  if (name.length > MAX_SUBNETWORK_NAME_LENGTH) {
    return `a subnetwork name is at most ${MAX_SUBNETWORK_NAME_LENGTH} characters, this one is ${name.length}`;
  }
  if (!SUBNETWORK_NAME_PATTERN.test(name)) {
    return (
      "a subnetwork name starts with a letter or digit and then contains only letters, digits, " +
      `dots, dashes and underscores -- "${name}" does not`
    );
  }
  return null;
}

/** True when `name` passes `subnetworkNameProblem`. */
export function isValidSubnetworkName(name: string): boolean {
  return subnetworkNameProblem(name) === null;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Encode one side's message. Both directions are a single UTF-8 JSON object -- there is no framing to get wrong. */
export function encodeRelayNetMessage(
  message: SubnetworkAnnouncement | SubnetworkAnnouncementReply,
): Uint8Array {
  return encoder.encode(JSON.stringify(message));
}

/**
 * Read the other end's whole message: everything it sends until it closes its
 * writing end, capped at `MAX_RELAY_NET_MESSAGE_BYTES` and bounded in time.
 *
 * HALF-CLOSE IS THE FRAMING. The sender writes one object and closes for
 * writing, so "the iteration ended" is "the message is complete". That is why
 * neither side needs a length prefix, and why both sides MUST close their
 * writing end before reading -- a side that waits to read without closing
 * deadlocks against a peer doing the same.
 */
async function readMessage(stream: Stream, timeoutMs: number): Promise<string> {
  const chunks: Uint8Array[] = [];
  let total = 0;

  const read = async (): Promise<string> => {
    for await (const chunk of stream) {
      const bytes = chunk.subarray();
      total += bytes.byteLength;
      if (total > MAX_RELAY_NET_MESSAGE_BYTES) {
        throw new Error(
          `${RELAY_NET_PROTOCOL}: the other end sent more than ${MAX_RELAY_NET_MESSAGE_BYTES} bytes`,
        );
      }
      chunks.push(bytes);
    }
    const joined = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      joined.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return decoder.decode(joined);
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      read(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(`${RELAY_NET_PROTOCOL}: the other end sent nothing within ${timeoutMs}ms`),
            ),
          timeoutMs,
        );
        // Never hold a process open on this timer alone.
        (timer as { unref?: () => void }).unref?.();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Parse what a peer sent. Returns a refusal rather than throwing: every
 * malformed announcement has an answer, and answering is this protocol's
 * entire reason for existing.
 */
export function parseAnnouncement(
  text: string,
):
  | { ok: true; subnetwork: string }
  | { ok: false; reason: SubnetworkRefusalReason; message: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {
      ok: false,
      reason: "malformed",
      message: `relay: that was not a ${RELAY_NET_PROTOCOL} announcement -- it did not parse as JSON.`,
    };
  }
  const name = (parsed as Partial<SubnetworkAnnouncement> | null)?.subnetwork;
  if (name == null || (typeof name === "string" && name.trim() === "")) {
    return {
      ok: false,
      reason: "no-subnetwork-name",
      message:
        "relay: no subnetwork name announced. This relay has no default subnetwork, so a peer " +
        "that announces none cannot reserve a circuit slot and cannot be dialled through it. " +
        "The name belongs in httpeers.json next to the relay address: relayAddrs: [{ addr, subnetwork }].",
    };
  }
  if (typeof name !== "string") {
    return {
      ok: false,
      reason: "malformed",
      message: `relay: the announced subnetwork is a ${typeof name}, not a string.`,
    };
  }
  const trimmed = name.trim();
  const problem = subnetworkNameProblem(trimmed);
  if (problem != null) {
    return {
      ok: false,
      reason: "invalid-subnetwork-name",
      message: `relay: "${trimmed}" is not a usable subnetwork name -- ${problem}.`,
    };
  }
  return { ok: true, subnetwork: trimmed };
}

export interface AnnounceSubnetworkInit extends AbortOptions {
  /** Defaults to `RELAY_NET_TIMEOUT_MS`. */
  timeoutMs?: number;
}

/**
 * Tell `relay` which subnetwork this node belongs to, and wait for it to say
 * whether it accepted.
 *
 * CALL THIS AFTER DIALING THE RELAY AND BEFORE THE RESERVATION LANDS. The
 * gater that enforces the partition receives only a `PeerId`, so the relay
 * has to already know a peer's name by the time that peer reserves. In
 * practice this stream opens on the connection the dial just established,
 * while libp2p's own reservation path is still waiting on identify -- so the
 * announcement wins comfortably. The relay does not depend on that: see
 * `./subnetwork-registry.ts`'s admission grace, which is what makes the
 * ordering a guarantee rather than a habit.
 *
 * Throws `SubnetworkRefusedError` when the relay refused, carrying the
 * relay's own words. Any other failure (the relay does not speak this
 * protocol, the connection dropped) throws an ordinary `Error`.
 */
export async function announceSubnetwork(
  node: Libp2p,
  relay: PeerId,
  subnetwork: string,
  init: AnnounceSubnetworkInit = {},
): Promise<void> {
  const problem = subnetworkNameProblem(subnetwork);
  if (problem != null) {
    throw new SubnetworkRefusedError(
      "invalid-subnetwork-name",
      `subnetwork: refusing to announce "${subnetwork}" -- ${problem}.`,
    );
  }

  const timeoutMs = init.timeoutMs ?? RELAY_NET_TIMEOUT_MS;
  const stream = await node.dialProtocol(relay, RELAY_NET_PROTOCOL, { signal: init.signal });
  try {
    stream.send(encodeRelayNetMessage({ subnetwork }));
    // Closes THIS end's writing half only -- see `readMessage`'s note. The
    // relay reads until this close and cannot answer before it.
    await stream.close();

    const reply = JSON.parse(await readMessage(stream, timeoutMs)) as SubnetworkAnnouncementReply;
    if (reply?.ok !== true) {
      throw new SubnetworkRefusedError(
        reply?.reason ?? "malformed",
        reply?.message ?? `${RELAY_NET_PROTOCOL}: the relay refused without saying why.`,
      );
    }
  } catch (err) {
    stream.abort(err instanceof Error ? err : new Error(String(err)));
    throw err;
  }
}

/**
 * The relay's half of the exchange, as a pure-ish function of the bytes: read
 * the announcement, ask `decide` what to do with it, answer, and report what
 * was accepted.
 *
 * SEPARATED FROM THE REGISTRY so the wire behaviour is testable without a
 * relay, and so `./subnetwork-registry.ts` holds the policy and nothing else.
 */
export async function serveAnnouncement(
  stream: Stream,
  decide: (subnetwork: string) => SubnetworkAnnouncementReply,
  timeoutMs: number = RELAY_NET_TIMEOUT_MS,
): Promise<SubnetworkAnnouncementReply> {
  let reply: SubnetworkAnnouncementReply;
  try {
    const parsed = parseAnnouncement(await readMessage(stream, timeoutMs));
    reply = parsed.ok ? decide(parsed.subnetwork) : parsed;
  } catch (err) {
    stream.abort(err instanceof Error ? err : new Error(String(err)));
    throw err;
  }

  try {
    stream.send(encodeRelayNetMessage(reply));
    await stream.close();
  } catch (err) {
    stream.abort(err instanceof Error ? err : new Error(String(err)));
    throw err;
  }
  return reply;
}
