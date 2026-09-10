/**
 * Unit coverage for `src/relay-discovery.ts`, written for the 2026-09-09
 * adoption (MESH-2). NOT RECOVERED CODE.
 *
 * BE CAREFUL WITH THIS FILE. Unlike everything else in this app,
 * `relay-discovery.ts` is **live code**: it implements what ADR-0023 ratified
 * and it is deployed and verified end to end (`notes/.../2026-09-08/
 * httpeers-demo-sites-deployed.md`). So a claim made here is a claim about
 * something running, and the four claims `tests/node-verify.mjs` already makes
 * about it are not repeated — these are the ones it does not make.
 *
 * Real loopback HTTP servers, not a stubbed `fetch`. The document is fetched
 * across a socket, with the `Access-Control-Allow-Origin` header the real
 * deployment sets, because every interesting failure here is about what arrives
 * rather than about what the code does with an object handed to it.
 *
 * CLAIMS AND THEIR SOURCES:
 *   - ADR-0023, `docs/httpeers/adr/0023-the-relay-describes-itself-and-nothing-else.md`
 *   - note 10, "Relay Discovery: The Bootstrap Document Replaces Hand-Copied
 *     Multiaddrs" — §2 the three properties, §3 CORS, §6 the absolute path
 *   - `relay-discovery.ts`'s own module comment and `assertPinnable`'s contract
 *
 * The TOFU section at the bottom is the one §4 of the work order names as
 * mandatory before this file moves anywhere. Read its comment before changing
 * anything in it: it does not assert what ADR-0023 requires, it asserts what
 * the code currently does, and the difference is the finding.
 */

import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { assertPinnable, RELAY_DOCUMENT_PATH, resolveRelayAddrs } from "../src/relay-discovery.js";

const RELAY_ID = "12D3KooWGzeWbY26SR3HC7tYBf9BNkJp6vyT5CevAJiZQVE29fFa";
const ATTACKER_ID = "12D3KooWSbcsiEz42VuGWJ425iy18haarpdqcLzGxw9gynn2k6no";
const LEGIT = `/dns4/relay.httpeers.net/tcp/443/tls/ws/p2p/${RELAY_ID}`;
const ATTACKER = `/dns4/relay.httpeers.net/tcp/443/tls/ws/p2p/${ATTACKER_ID}`;

const running: Server[] = [];

afterEach(async () => {
  await Promise.all(running.splice(0).map((s) => new Promise((r) => s.close(() => r(null)))));
});

/**
 * A relay's ingress. `respond` returns the document to serve, or `null` for the
 * 404 a relay that cleared its document produces — note 10 §2's third property.
 * It is a function, not a value, so a test can change the answer between calls,
 * which is what the TOFU section needs.
 */
async function serveDocument(
  respond: () => unknown | null,
  opts: { cors?: boolean; status?: number; raw?: string } = {},
): Promise<string> {
  const server = createServer((req, res) => {
    if (opts.cors !== false) res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Content-Type", "application/json");
    if (req.url !== RELAY_DOCUMENT_PATH) {
      res.writeHead(404).end(JSON.stringify({ error: "not-found" }));
      return;
    }
    const body = respond();
    if (body == null) {
      res.writeHead(opts.status ?? 404).end(JSON.stringify({ error: "not-found" }));
      return;
    }
    res.writeHead(opts.status ?? 200).end(opts.raw ?? JSON.stringify(body));
  });
  running.push(server);
  await new Promise((r) => server.listen(0, "127.0.0.1", () => r(null)));
  const { port } = server.address() as { port: number };
  return `http://127.0.0.1:${port}`;
}

// ---------------------------------------------------------------------------
// "Accepts either form … The multiaddr form is kept for local development,
// where the relay is a process on loopback with no document and no Caddy in
// front of it." — resolveRelayAddrs.
// ---------------------------------------------------------------------------

describe("the two forms a relay can be named by", () => {
  it("a multiaddr is used as-is, with no fetch at all", async () => {
    // Asserted by giving it an address no server is listening on: if it were
    // fetched, this would fail rather than return.
    await expect(resolveRelayAddrs(LEGIT)).resolves.toEqual([LEGIT]);
  });

  it("a multiaddr bypasses validation entirely, peer id or not", async () => {
    // Worth pinning because it is a real asymmetry: `assertPinnable` guards the
    // DOCUMENT path only. A hand-configured multiaddr with no `/p2p/` is
    // accepted, and it is exactly the value note 10 §4 records as the previous
    // hardcoded default — "which would have authenticated nothing".
    const unpinnable = "/dns4/relay.httpeers.net/tcp/443/tls/ws";
    await expect(resolveRelayAddrs(unpinnable)).resolves.toEqual([unpinnable]);
  });

  it("a URL is resolved through the document", async () => {
    const url = await serveDocument(() => ({ relayAddrs: [LEGIT] }));
    await expect(resolveRelayAddrs(url)).resolves.toEqual([LEGIT]);
  });

  it("the document may list several addresses and all of them come back", async () => {
    const six = `/ip6/::1/tcp/443/tls/ws/p2p/${RELAY_ID}`;
    const url = await serveDocument(() => ({ relayAddrs: [LEGIT, six] }));
    await expect(resolveRelayAddrs(url)).resolves.toEqual([LEGIT, six]);
  });
});

// ---------------------------------------------------------------------------
// "Exactly one `/p2p/` is required. None means the peer id is missing, and the
// connection would authenticate nothing. Two means an announce address was
// hand-written carrying a peer id that libp2p then appended to again — a
// misconfiguration on the relay that produces an address which parses and never
// dials." — assertPinnable.
//
// `node-verify.mjs` covers the none case. The two case and the not-a-multiaddr
// case are only here.
// ---------------------------------------------------------------------------

describe("assertPinnable", () => {
  it("accepts exactly one /p2p/", () => {
    expect(() => assertPinnable(LEGIT, "src")).not.toThrow();
  });

  it("refuses none, because the connection would authenticate nothing", () => {
    expect(() => assertPinnable("/dns4/relay.httpeers.net/tcp/443/tls/ws", "src")).toThrow(
      /0 \/p2p\/ components; exactly one is required/,
    );
  });

  it("refuses two, which parses and never dials", () => {
    // SYMMETRIC PAIR (§5.3) with the none case, and the half the adopted
    // harness does not reach: `count !== 1` has two sides and only one was
    // covered.
    expect(() => assertPinnable(`${LEGIT}/p2p/${ATTACKER_ID}`, "src")).toThrow(
      /2 \/p2p\/ components; exactly one is required/,
    );
  });

  it("refuses a string that is not a multiaddr at all", () => {
    expect(() => assertPinnable("relay.httpeers.net", "src")).toThrow(/which is not a multiaddr/);
  });

  it("refuses a non-string", () => {
    expect(() => assertPinnable(null as unknown as string, "src")).toThrow(
      /which is not a multiaddr/,
    );
  });

  it("names the source in the error, so a reader knows which relay lied", () => {
    expect(() => assertPinnable("nonsense", "https://relay.test/.well-known/x")).toThrow(
      /https:\/\/relay\.test/,
    );
  });

  it("explains WHY in the message, because the reason is the security property", () => {
    expect(() => assertPinnable("/dns4/x/tcp/1/ws", "src")).toThrow(
      /peer id is what the client pins and what Noise verifies/,
    );
  });
});

describe("every address in the document is validated", () => {
  it("the LAST entry is checked, not only the first", async () => {
    // FINAL-ITERATION PATH (§5.3). A loop that validated `addrs[0]` and
    // returned, or one that dropped its last iteration, would pass every
    // single-address test — and `node-verify.mjs` only ever serves one.
    const url = await serveDocument(() => ({
      relayAddrs: [LEGIT, `/ip6/::1/tcp/443/tls/ws/p2p/${RELAY_ID}`, "/dns4/x/tcp/1/ws"],
    }));
    await expect(resolveRelayAddrs(url)).rejects.toThrow(/0 \/p2p\/ components/);
  });

  it("the FIRST entry is checked too", async () => {
    const url = await serveDocument(() => ({ relayAddrs: ["/dns4/x/tcp/1/ws", LEGIT] }));
    await expect(resolveRelayAddrs(url)).rejects.toThrow(/0 \/p2p\/ components/);
  });

  it("one bad entry rejects the whole document rather than being filtered out", async () => {
    // A filter would be the dangerous reading: the peer would silently use
    // whatever survived, and a relay misconfiguring one of its addresses would
    // never be noticed.
    const url = await serveDocument(() => ({ relayAddrs: [LEGIT, "/dns4/x/tcp/1/ws"] }));
    await expect(resolveRelayAddrs(url)).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Note 10 §2, third property: "A 404 means the relay is down, not that the URL
// is wrong. The relay clears its document BEFORE starting, so a crash-looping
// relay yields 404 rather than a stale document Caddy would keep serving."
// ---------------------------------------------------------------------------

describe("what each failure means", () => {
  it("a 404 says the relay is not running, and says why that is what it means", async () => {
    const url = await serveDocument(() => null);
    await expect(resolveRelayAddrs(url)).rejects.toThrow(
      /returned 404.*A 404 means the relay is not running/s,
    );
  });

  it("a 500 is also refused, naming the status", async () => {
    const url = await serveDocument(() => ({ relayAddrs: [LEGIT] }), { status: 500 });
    await expect(resolveRelayAddrs(url)).rejects.toThrow(/returned 500/);
  });

  it("an unreachable origin mentions the CORS header, because that is where a browser lands", async () => {
    // Note 10 §3 and the module comment: "If that header is ever dropped,
    // `curl` keeps working and every browser peer stops, which is the failure
    // this comment exists to make searchable." The message is the only thing
    // that makes it searchable, so the message is asserted.
    const err = await resolveRelayAddrs("http://127.0.0.1:1/").catch((e: Error) => e);
    expect((err as Error).message).toMatch(/could not fetch the relay's bootstrap document/);
    expect((err as Error).message).toMatch(/Access-Control-Allow-Origin/);
  });

  it("a document with no relayAddrs key is refused", async () => {
    const url = await serveDocument(() => ({}));
    await expect(resolveRelayAddrs(url)).rejects.toThrow(/lists no addresses/);
  });

  it("a document whose relayAddrs is not an array is refused", async () => {
    const url = await serveDocument(() => ({ relayAddrs: LEGIT }));
    await expect(resolveRelayAddrs(url)).rejects.toThrow(/lists no addresses/);
  });

  it("an empty list is an error rather than an empty answer", async () => {
    // "Parsing it happily and concluding the relay has no address is worse than
    // an error, so this is one."
    const url = await serveDocument(() => ({ relayAddrs: [] }));
    await expect(resolveRelayAddrs(url)).rejects.toThrow(/lists no addresses/);
  });
});

// ---------------------------------------------------------------------------
// Note 10 §6, found while writing the original fixtures: "The document path is
// ABSOLUTE, so `new URL('/.well-known/…', base)` resolves from the ORIGIN and
// discards any path in the configured URL. A first attempt at the failure-path
// fixtures used `${url}/unpinnable/` and all three silently hit the happy path
// — the fixtures were wrong, not the code. Worth knowing in its own right:
// configuring a relay URL with a path prefix silently ignores the prefix."
// ---------------------------------------------------------------------------

describe("a path in the configured relay URL is silently ignored", () => {
  it("resolves from the origin, discarding the prefix", async () => {
    // This is the behaviour that made three of the original fixtures useless.
    // It is pinned here so the next person meets it as a test rather than as a
    // confusing green run.
    const url = await serveDocument(() => ({ relayAddrs: [LEGIT] }));
    await expect(resolveRelayAddrs(`${url}/some/prefix`)).resolves.toEqual([LEGIT]);
  });

  it("a query string and a fragment are discarded too", async () => {
    const url = await serveDocument(() => ({ relayAddrs: [LEGIT] }));
    await expect(resolveRelayAddrs(`${url}/?x=1#frag`)).resolves.toEqual([LEGIT]);
  });

  it("the path constant is the absolute one, which is what makes that true", () => {
    expect(RELAY_DOCUMENT_PATH).toBe("/.well-known/httpeers-relay.json");
    expect(RELAY_DOCUMENT_PATH.startsWith("/")).toBe(true);
  });
});

// ===========================================================================
// THE TOFU INVERSION — §4 of the work order names this as mandatory before
// `relay-discovery.ts` moves anywhere, and ADR-0023 is where the property comes
// from. Tracked as **umbrella #27** (`ready-for-human`).
//
// THE FINDING: `relay-discovery.ts` implements NO PINNING. `resolveRelayAddrs`
// fetches the document, checks `assertPinnable`, and returns. There is no stored
// peer id, no comparison against a previously-seen one, and no re-pin path — and
// ADR-0023 calls "a deliberate, human-initiated re-pin path" MANDATORY.
//
// So the inversion ADR-0023 describes cannot be demonstrated against this code,
// for the plain reason that **there is nothing to invert**. Three consequences,
// and the second is the one that matters:
//
//   1. There is no first use to pin on, so this is trust-on-EVERY-use. An
//      attacker who controls the document at ANY moment substitutes the relay's
//      identity, not only one who controls first contact — so the exposure is
//      WIDER than the ADR's own worst case, not narrower.
//   2. The fail-loud rule CANNOT FIRE, because there is no stored value to
//      compare against. The failure mode is not "the inversion happens"; it is
//      that there is nothing to invert.
//   3. The mandatory re-pin path does not exist, because nothing is pinned. The
//      module's export surface has nowhere to put one.
//
// `assertPinnable` IS NOT THE PIN, and this is the whole finding. It makes an
// address *pinnable* — exactly one peer id, so Noise can verify it on that dial.
// That is PER-DIAL AUTHENTICATION and says nothing across time. Note 10 §2's
// "that peer id is … what the client pins" is true of Noise and NOT of storage,
// and someone will re-read that sentence and conclude the property is covered.
//
// ---------------------------------------------------------------------------
// THE FORM, IN TWO PARTS, and why it is not one permanently-red test.
//
// A permanently-red suite gets ignored and then deleted, so the gap is split:
//
//   PART 1 — CHARACTERISATION. Tests that pin what the code actually does
//     today, so a change of contract cannot land silently. Same pattern
//     `apps/httpeers-shell-protos/PROVENANCE.md` uses for the defects it found.
//
//     WHICH OF THEM ARE ACTUALLY TRIPWIRES — measured, not assumed, by applying
//     a throwaway pin store and watching the suite (see PROVENANCE.md):
//       * "there is no first use…"        → RED. Any implementation that pins an
//       * "trust-on-EVERY-use…"             identity and refuses a change fails
//                                           both of these. These two are THE
//                                           tripwire.
//       * "exports no pin store…"         → RED only once a re-pin accessor is
//                                           added to the module surface.
//       * "resolveRelayAddrs is pure…"    → stays green under pinning, because
//       * "assertPinnable checks SHAPE…"    neither is about storage. They are
//                                           characterisations, not tripwires,
//                                           and are here to make the mechanism's
//                                           absence legible.
//
//   PART 2 — ONE EXPLICITLY-PENDING TEST naming the ratified requirement, so it
//     is visible in the runner output rather than silently absent. The work
//     order sanctions this shape directly: §3's SH-1 says to "carry the two
//     known holes forward as failing or explicitly-pending tests rather than
//     silently inheriting them".
//
// `pnpm test` therefore stays green and honest, and neither the gap nor its
// status is inferable-only.
//
// WHAT WAS DELIBERATELY NOT DONE: inventing a pin store to make a green test.
// That would be designing a security mechanism under cover of a test adoption,
// and ADR-0023 deliberately constrains the re-pin path as a human-initiated
// decision — so it is ADR territory, and not a thing a test adoption gets to
// settle. Hence #27 is `ready-for-human`.
// ===========================================================================

describe("TOFU part 1 — CHARACTERISATION: what the code does today (red when pinning lands)", () => {
  it("there is no first use: a changed peer id is accepted on the second call, not refused", async () => {
    // THE INVERSION SCENARIO, run for real. First contact is compromised and
    // serves the attacker's peer id; the legitimate relay then answers with its
    // own. Under ADR-0023's ratified design the SECOND call must fail loud,
    // because the first pinned the attacker.
    //
    // What actually happens: both calls succeed and simply return whatever was
    // served. The failure mode is therefore not "inverted" — it is ABSENT, and
    // the exposure is wider than the ADR describes, because an attacker who
    // controls the document at ANY moment substitutes the relay's identity, not
    // only one who controls the first contact.
    let current = ATTACKER;
    const url = await serveDocument(() => ({ relayAddrs: [current] }));

    const first = await resolveRelayAddrs(url);
    expect(first).toEqual([ATTACKER]);

    current = LEGIT;
    const second = await resolveRelayAddrs(url);

    // ADR-0023 requires this to have thrown, loudly, against the legitimate
    // relay. It resolves.
    expect(second).toEqual([LEGIT]);
    expect(second).not.toEqual(first);
  });

  it("trust-on-EVERY-use: the identity can change back and forth with no complaint", async () => {
    // Stated separately because it is the part that is worse than the ADR's
    // own worst case. Pin-on-first-use at least fixes the identity; this fixes
    // nothing, so the window is every call rather than the first.
    let current = LEGIT;
    const url = await serveDocument(() => ({ relayAddrs: [current] }));
    const seen: string[][] = [];
    for (const next of [ATTACKER, LEGIT, ATTACKER]) {
      seen.push(await resolveRelayAddrs(url));
      current = next;
    }
    expect(seen).toEqual([[LEGIT], [ATTACKER], [LEGIT]]);
  });

  it("resolveRelayAddrs is pure with respect to trust: nothing is remembered between calls", async () => {
    // The mechanical version of the two above, and the one that states the
    // absent mechanism directly: two DIFFERENT relays resolved in sequence do
    // not interfere, because neither writes anything down.
    const a = await serveDocument(() => ({ relayAddrs: [LEGIT] }));
    const b = await serveDocument(() => ({ relayAddrs: [ATTACKER] }));
    expect(await resolveRelayAddrs(a)).toEqual([LEGIT]);
    expect(await resolveRelayAddrs(b)).toEqual([ATTACKER]);
    expect(await resolveRelayAddrs(a)).toEqual([LEGIT]);
  });

  it("the module exports no pin store, no pinned-peer accessor and no re-pin path", async () => {
    // ADR-0023 calls a "deliberate, human-initiated re-pin path" MANDATORY.
    // There is no surface through which one could be offered, which is a
    // stronger statement than "it is not called anywhere": it cannot be,
    // because the export surface has nowhere to put it.
    //
    // This test passes by demonstrating an absence, so a green run here must
    // not be read as covering the requirement — it records that the
    // requirement has no implementation. It turns red when one is added.
    const module = await import("../src/relay-discovery.js");
    expect(Object.keys(module).sort()).toEqual([
      "RELAY_DOCUMENT_PATH",
      "assertPinnable",
      "resolveRelayAddrs",
    ]);
  });

  it("assertPinnable checks SHAPE, not IDENTITY — it cannot be mistaken for the pin", async () => {
    // The distinction that makes the four tests above necessary rather than
    // pedantic. `assertPinnable` is happy with any well-formed peer id,
    // including one it has never seen, so passing it is not evidence that the
    // relay is the relay.
    expect(() => assertPinnable(LEGIT, "src")).not.toThrow();
    expect(() => assertPinnable(ATTACKER, "src")).not.toThrow();
    // It takes no expected identity, and there is no overload that does.
    expect(assertPinnable.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// PART 2 — the explicitly-pending test. One test, skipped, naming the ratified
// requirement so it appears in the runner output as pending rather than being
// absent and therefore inferable only from prose.
//
// DO NOT DELETE THIS TO TIDY THE OUTPUT, and do not make it pass by writing a
// pin store here. It is skipped because the mechanism it asserts DOES NOT EXIST
// — see umbrella #27 — not because it is flaky, slow, or superseded.
//
// WHEN PINNING IS IMPLEMENTED: remove `.skip`, and expect every test in part 1
// above to go red at the same time. That is deliberate. Their redness is the
// signal that this file's contract changed.
// ---------------------------------------------------------------------------

describe("TOFU part 2 — PENDING: the requirement ADR-0023 ratified", () => {
  it.skip("PENDING (umbrella #27, ratified but UNIMPLEMENTED): a compromised first contact pins the attacker permanently, and the fail-loud rule then fires against the legitimate relay", async () => {
    // ADR-0023 § Consequences, verbatim:
    //
    //   "Trust becomes pin-on-first-use, and its failure mode inverts. Before
    //    the first fetch, trust rests on DNS and the certificate authority.
    //    After pinning, it equals a configured peerId. But a compromised first
    //    contact pins the *attacker's* identity permanently — and the fail-loud
    //    rule then fires against the **legitimate** relay. That is not
    //    'degraded to no pinning'; it is locked to the attacker while loudly
    //    rejecting the real one. A deliberate, human-initiated re-pin path is
    //    therefore mandatory, and it must never be triggered by the relay, the
    //    document, or a field inside it."
    //
    // `src/relay-discovery.ts` implements none of this. The assertions below
    // are what the ratified design requires, written out so that the
    // requirement is executable the day the mechanism exists — and so that
    // what is missing is legible here rather than only in prose.
    let current = ATTACKER;
    const url = await serveDocument(() => ({ relayAddrs: [current] }));

    // First contact, compromised. Under pin-on-first-use this is the moment
    // the attacker's identity is pinned, permanently.
    expect(await resolveRelayAddrs(url)).toEqual([ATTACKER]);

    // The legitimate relay now answers with its own, correct identity.
    current = LEGIT;

    // THE INVERSION: this must FAIL LOUD, and it must fail against the
    // LEGITIMATE relay, naming the pinned peer id it was expecting. Anything
    // quieter — resolving, or falling back to "no pinning" — is the failure
    // ADR-0023 says this is "not".
    await expect(resolveRelayAddrs(url)).rejects.toThrow(/pinned/i);

    // And the only way back is a deliberate, human-initiated re-pin. There is
    // no such export today, which is why this test is pending and not merely
    // failing — the assertion cannot even be written against the current
    // module surface without inventing the API it is meant to check.
  });
});
