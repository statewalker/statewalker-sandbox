#!/usr/bin/env node
/**
 * The mutation harness for this app — §5.3 of
 * `notes/2026/2026-09/2026-09-09/[umbrella-next].prototype-adoption.md`: "a suite that has
 * never been proven able to fail is not evidence."
 *
 *     node tools/mutate.mjs              # every mutant
 *     ONLY="H3,M13" node tools/mutate.mjs
 *
 * Copied from `apps/httpeers-wire-protos/tools/mutate.mjs`, with its two guards intact and
 * one addition. Applies one mutation at a time by exact string replacement, runs the suite,
 * records KILLED / SURVIVED, and restores the file — including on `process.exit`, so an
 * interrupted run does not leave a mutated tree behind. Verify with `git status` anyway.
 *
 * THE TWO GUARDS, INHERITED. Keep them in any copy of this file:
 *
 *  1. AN UNMUTATED CONTROL RUNS FIRST and must be green with a parsable tally, or the
 *     harness exits before testing anything.
 *  2. A RUN WHOSE TALLY LINE DID NOT PARSE is reported as HARNESS-ERROR, never as KILLED.
 *
 * Without them the wire-protos harness reported 27 mutants out of 27 killed and the suite
 * looked perfect. The cause was `--reporter=basic`, which does not exist in Vitest 4: every
 * run died loading the reporter, exited non-zero, and scored as a kill. A harness that
 * cannot tell "the suite failed" from "the suite never ran" will always tell you your tests
 * are perfect, which is the one answer a mutation pass must not be able to give.
 *
 * THE ADDITION, for this app specifically. There are TWO suites here: 106 unit tests under
 * vitest, and 13 integration claims in `tests/node-verify.mjs`, which is adopted verbatim
 * and runs as a plain Node script. The harness scores against the UNIT suite, because that
 * is the suite MESH-2 added and therefore the one that has to be proven. But any mutant
 * that survives it is then re-run against the integration harness, and reported as
 * `SURVIVED-UNIT/KILLED-INT` when the adopted claims catch what the unit tests missed.
 * That distinction is the whole point of §4's "that is integration coverage, not unit
 * coverage": a mutant in that state is covered, but not where it should be.
 *
 * Two mutation shapes are mandatory per §5.3, each having already survived once in this
 * project: FINAL-ITERATION PATHS and SYMMETRIC PAIRS. Rows below are tagged with which.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The app root: this file lives in `<app>/tools/`. */
const APP = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** @type {{id:string,file:string,from:string,to:string,note:string}[]} */
const MUTANTS = [
  // ===================== hub.ts =====================
  {
    id: "H1  membership keyed on a BODY field, not the proven caller",
    file: "src/hub.ts",
    from: "      state.members.add(callerPeerId);",
    to: "      state.members.add((body as { member?: string }).member ?? callerPeerId);",
    note: "the impersonation the module comment rules out",
  },
  {
    id: "H2  advertisement keyed on a BODY field",
    file: "src/hub.ts",
    from: "      state.advertisements.set(callerPeerId, ad);",
    to: "      state.advertisements.set((ad as unknown as { peerId?: string }).peerId ?? callerPeerId, ad);",
    note: "symmetric pair with H1: the other route that keys on identity",
  },
  {
    id: "H3  spent check runs SECOND instead of first",
    file: "src/hub.ts",
    from: `      if (state.spentInvitations.has(id)) return json({ error: "already-redeemed" }, 403);
      if (!state.openInvitations.has(id)) return json({ error: "unknown-invitation" }, 403);`,
    to: `      if (!state.openInvitations.has(id)) return json({ error: "unknown-invitation" }, 403);
      if (state.spentInvitations.has(id)) return json({ error: "already-redeemed" }, 403);`,
    note: "the ordering claim, stated as 'first and unconditionally'",
  },
  {
    id: "H4  spent check removed entirely",
    file: "src/hub.ts",
    from: '      if (state.spentInvitations.has(id)) return json({ error: "already-redeemed" }, 403);',
    to: "      void 0;",
    note: "single-use",
  },
  {
    id: "H5  redemption not recorded as spent",
    file: "src/hub.ts",
    from: "      state.spentInvitations.add(id);",
    to: "      void id;",
    note: "spent becomes indistinguishable from never-existed",
  },
  {
    id: "H6  membership gate removed",
    file: "src/hub.ts",
    from: `    if (!state.members.has(callerPeerId)) {
      return json({ error: "not-a-member", caller: callerPeerId }, 403);
    }`,
    to: "    void 0;",
    note: "note 08 claim 3",
  },
  {
    id: "H7  gate also closes the invite route, so the hub is unjoinable",
    file: "src/hub.ts",
    from: '    if (url.pathname === "/.well-known/invite" && request.method === "POST") {',
    to: '    if (url.pathname === "/.well-known/invite" && request.method === "POST" && state.members.has(callerPeerId)) {',
    note: "symmetric pair with H6: the gate's other side",
  },
  {
    id: "H8  mesh view drops the LAST advertisement",
    file: "src/hub.ts",
    from: "        advertisements: [...state.advertisements.entries()].map(([peerId, ad]) => ({",
    to: "        advertisements: [...state.advertisements.entries()].slice(0, -1).map(([peerId, ad]) => ({",
    note: "FINAL-ITERATION",
  },
  {
    id: "H9  mesh view drops the LAST member",
    file: "src/hub.ts",
    from: "        members: [...state.members],",
    to: "        members: [...state.members].slice(0, -1),",
    note: "FINAL-ITERATION, symmetric pair with H8",
  },
  {
    id: "H10 re-advertising appends rather than replaces",
    file: "src/hub.ts",
    from: "      const ad = (await request.json()) as Advertisement;",
    to: "      const ad = (await request.json()) as Advertisement;\n      if (state.advertisements.has(callerPeerId)) return json({ ok: true });",
    note: "stale advertisement survives",
  },
  {
    id: "H11 guest echo loses the caller",
    file: "src/hub.ts",
    from: '      return json({ from: guestName, echoed: body.message ?? "", caller: callerPeerId });',
    to: '      return json({ from: guestName, echoed: body.message ?? "", caller: "unknown" });',
    note: "symmetric pair: the guest side of identity",
  },
  {
    id: "H12 guest echo ignores the method",
    file: "src/hub.ts",
    from: '    if (url.pathname === "/echo" && request.method === "POST") {',
    to: '    if (url.pathname === "/echo") {',
    note: "route shape",
  },
  {
    id: "H13 invite route ignores the method, so a GET redeems",
    file: "src/hub.ts",
    from: '    if (url.pathname === "/.well-known/invite" && request.method === "POST") {\n      const body',
    to: '    if (url.pathname === "/.well-known/invite") {\n      const body',
    note: "symmetric pair with H12",
  },
  {
    id: "H14 not-found answered as 403 rather than 404",
    file: "src/hub.ts",
    from: '    return json({ error: "not-found", path: url.pathname }, 404);\n  };\n}\n\n/**\n * A guest\'s routes',
    to: '    return json({ error: "not-found", path: url.pathname }, 403);\n  };\n}\n\n/**\n * A guest\'s routes',
    note: "authorization answer hides a routing mistake",
  },
  {
    id: "H15 base64url keeps + and /, so a blob breaks a URL",
    file: "src/hub.ts",
    from: '  return btoa(binary).replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/, "");',
    to: '  return btoa(binary).replace(/=+$/, "");',
    note: "the copy-paste property",
  },
  {
    id: "H16 base64url keeps its padding",
    file: "src/hub.ts",
    from: '  return btoa(binary).replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/, "");',
    to: '  return btoa(binary).replace(/\\+/g, "-").replace(/\\//g, "_");',
    note: "the copy-paste property, the other half",
  },
  {
    id: "H17 joinMesh drops the STATUS half of the refusal check",
    file: "src/hub.ts",
    from: "  if (redeemed.status !== 200 || result.ok !== true) {",
    to: "  if (result.ok !== true) {",
    note: "symmetric pair: two halves of one condition",
  },
  {
    id: "H18 joinMesh drops the ok:true half",
    file: "src/hub.ts",
    from: "  if (redeemed.status !== 200 || result.ok !== true) {",
    to: "  if (redeemed.status !== 200) {",
    note: "symmetric pair, the other half",
  },
  {
    id: "H19 joinMesh advertises even when the join was refused",
    file: "src/hub.ts",
    from: "    throw new Error(`join refused: ${result.error ?? redeemed.status}`);",
    to: "    void 0;",
    note: "a non-member in the mesh view",
  },
  {
    id: "H20 joinMesh advertises without an address",
    file: "src/hub.ts",
    from: "      body: JSON.stringify({ ...advertisement, address: peer.address }),",
    to: "      body: JSON.stringify({ ...advertisement }),",
    note: "the address the reverse call dials",
  },
  {
    id: "H21 joinMesh redeems without its own address",
    file: "src/hub.ts",
    from: "      body: JSON.stringify({ invitationId: blob.invitationId, address: peer.address }),",
    to: "      body: JSON.stringify({ invitationId: blob.invitationId }),",
    note: "symmetric pair with H20",
  },
  {
    id: "H22 mintInvitation does not record the invitation",
    file: "src/hub.ts",
    from: "  state.openInvitations.add(id);",
    to: "  void id;",
    note: "nothing can ever be redeemed",
  },
  {
    id: "H23 randomId is a constant, so two invitations collide",
    file: "src/hub.ts",
    from: "  const bytes = new Uint8Array(16);\n  crypto.getRandomValues(bytes);",
    to: "  const bytes = new Uint8Array(16);",
    note: "each guest needs its own",
  },

  // ===================== mesh.ts =====================
  {
    id: "M1  reusablePeer's regex is not anchored, so a mid-address peer id matches",
    file: "src/mesh.ts",
    from: "  const match = /\\/p2p\\/([^/]+)$/.exec(address)",
    to: "  const match = /\\/p2p\\/([^/]+)/.exec(address)",
    note: "the request would go to the RELAY, not the target",
  },
  {
    id: "M2  reusablePeer ignores getConnections and always reuses",
    file: "src/mesh.ts",
    from: "    return node.getConnections(peerId).length > 0 ? peerId : null",
    to: "    return peerId",
    note: "finding two: first contact would dial a peer id with no connection",
  },
  {
    id: "M3  reusablePeer always returns null, so nothing is ever reused",
    file: "src/mesh.ts",
    from: "    return node.getConnections(peerId).length > 0 ? peerId : null",
    to: "    return null",
    note: "symmetric pair with M2: finding two undone the other way",
  },
  {
    id: "M4  reusablePeer's catch removed, so a malformed id throws",
    file: "src/mesh.ts",
    from: "  } catch {\n    return null;\n  }\n}",
    to: "  } finally {\n    void 0;\n  }\n}",
    note: "'or is malformed — every case meaning dial the address'",
  },
  {
    id: "M5  the retry dials the PEER ID, reusing what just failed",
    file: "src/mesh.ts",
    from: "        return await callOnce(multiaddr(target));\n      }",
    to: "        return await callOnce(reusablePeer(node, target) ?? multiaddr(target));\n      }",
    note: "finding one: the retry must dial afresh",
  },
  {
    id: "M6  the retry closes EVERY connection, including unlimited ones",
    file: "src/mesh.ts",
    from: "          if (connection.limits != null) await connection.close()",
    to: "          await connection.close()",
    note: "SYMMETRIC PAIR: throws away a WebRTC upgrade",
  },
  {
    id: "M7  the retry closes nothing",
    file: "src/mesh.ts",
    from: "          if (connection.limits != null) await connection.close()",
    to: "          void connection",
    note: "symmetric pair, the other side",
  },
  {
    id: "M8  no retry at all",
    file: "src/mesh.ts",
    from: "      } catch {\n        // Drop whatever we were holding and dial the address afresh.",
    to: "      } catch (err) {\n        throw err;\n        // Drop whatever we were holding and dial the address afresh.",
    note: "finding one's mitigation removed",
  },
  {
    id: "M9  dialAnyRelay does not stop at the first success",
    file: "src/mesh.ts",
    from: "      await node.dial(multiaddr(addr));\n      return;",
    to: "      await node.dial(multiaddr(addr));",
    note: "accumulates circuits; note 08 §5's own hazard",
  },
  {
    id: "M10 dialAnyRelay reports only the FIRST failure",
    file: "src/mesh.ts",
    from: '  throw new Error(`could not dial the relay at any published address:\\n  ${failures.join("\\n  ")}`);',
    to: "  throw new Error(`could not dial the relay at any published address:\\n  ${failures[0]}`);",
    note: "note 10 §4: reporting every error is the point",
  },
  {
    id: "M11 dialAnyRelay drops the LAST failure from its report",
    file: "src/mesh.ts",
    from: '  throw new Error(`could not dial the relay at any published address:\\n  ${failures.join("\\n  ")}`);',
    to: '  throw new Error(`could not dial the relay at any published address:\\n  ${failures.slice(0, -1).join("\\n  ")}`);',
    note: "FINAL-ITERATION",
  },
  {
    id: "M12 the plain circuit address is preferred over /webrtc",
    file: "src/mesh.ts",
    from: "    const chosen = webrtc ?? circuit",
    to: "    const chosen = circuit ?? webrtc",
    note: "SYMMETRIC PAIR: the browser peer never leaves the relay",
  },
  {
    id: "M13 waitForCircuitAddress reads getMultiaddrs once instead of polling",
    file: "src/mesh.ts",
    from: "    if (Date.now() > deadline) {",
    to: "    if (true as boolean) {",
    note: "the reservation appears AFTER dial resolves",
  },
  {
    id: "M14 the response body is not buffered before close()",
    file: "src/mesh.ts",
    from: `          return new Response(await response.arrayBuffer(), {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
          });`,
    to: "          return response",
    note: "a streamed body read after close() is truncated",
  },
  {
    id: "M15 the rebuild loses statusText",
    file: "src/mesh.ts",
    from: "            statusText: response.statusText,",
    to: '            statusText: "",',
    note: "SYMMETRIC PAIR with M16: fields carried by hand",
  },
  {
    id: "M16 the rebuild loses the headers",
    file: "src/mesh.ts",
    from: "            headers: response.headers",
    to: "            headers: {}",
    note: "symmetric pair with M15",
  },
  {
    id: "M17 close() only on success, not in a finally",
    file: "src/mesh.ts",
    from: "        } finally {",
    to: "          await close()\n        } catch (err) {\n          throw err\n        } finally {\n          if (false as boolean)",
    note: "SYMMETRIC PAIR: the failure path is the one that leaks",
  },
  {
    id: "M18 the SERVING end drops runOnLimitedConnection",
    file: "src/mesh.ts",
    from: "    { node, runOnLimitedConnection: true },",
    to: "    { node, runOnLimitedConnection: false },",
    note: "SYMMETRIC PAIR: both ends must opt in",
  },
  {
    id: "M19 the DIALLING end drops runOnLimitedConnection",
    file: "src/mesh.ts",
    from: "        const { call, close } = await connect({ node, peer, runOnLimitedConnection: true })",
    to: "        const { call, close } = await connect({ node, peer, runOnLimitedConnection: false })",
    note: "symmetric pair, the other end",
  },
  {
    id: "M20 one handler for every stream: identity is the LAST peer seen",
    file: "src/mesh.ts",
    from: "      serveFetchOverDuplex((request) => init.handler(request, remotePeer.toString())),",
    to: "      ((node as unknown as { __last?: string }).__last = remotePeer.toString(),\n      serveFetchOverDuplex((request) =>\n        init.handler(request, (node as unknown as { __last?: string }).__last as string),\n      )),",
    note: "identity by closure, replaced by shared state",
  },
  {
    id: "M21 the caller's transports are dropped",
    file: "src/mesh.ts",
    from: "    transports: [...(init.transports as any[]), circuitRelayTransport()],",
    to: "    transports: [circuitRelayTransport()],",
    note: "the isomorphism seam",
  },
  {
    id: "M22 the node does not listen on /p2p-circuit",
    file: "src/mesh.ts",
    from: '    addresses: { listen: ["/p2p-circuit"] },',
    to: "    addresses: { listen: [] },",
    note: "a tab has no listening socket",
  },
  {
    id: "M23 the connection gater denies private multiaddrs",
    file: "src/mesh.ts",
    from: "      denyDialMultiaddr: async () => false",
    to: "      denyDialMultiaddr: async () => true",
    note: "a local relay is a private address",
  },
  {
    id: "M25 json() ignores the status it is given",
    file: "src/mesh.ts",
    from: "  return new Response(JSON.stringify(body), {\n    status,",
    to: "  return new Response(JSON.stringify(body), {\n    status: 200,",
    note: "every refusal would read as success",
  },

  // ===================== relay-discovery.ts =====================
  {
    id: "R1  assertPinnable accepts any number of /p2p/ components",
    file: "src/relay-discovery.ts",
    from: "  if (count !== 1) {",
    to: "  if (count > 99) {",
    note: "the document's entire security value",
  },
  {
    id: "R2  assertPinnable accepts ZERO (only rejects two or more)",
    file: "src/relay-discovery.ts",
    from: "  if (count !== 1) {",
    to: "  if (count > 1) {",
    note: "SYMMETRIC PAIR: an address that authenticates nothing",
  },
  {
    id: "R3  assertPinnable accepts TWO (only rejects none)",
    file: "src/relay-discovery.ts",
    from: "  if (count !== 1) {",
    to: "  if (count < 1) {",
    note: "symmetric pair, the other side — parses and never dials",
  },
  {
    id: "R4  only the FIRST published address is validated",
    file: "src/relay-discovery.ts",
    from: "  for (const addr of addrs) assertPinnable(addr, url);",
    to: "  assertPinnable(addrs[0] as string, url);",
    note: "FINAL-ITERATION",
  },
  {
    id: "R5  the LAST published address is skipped",
    file: "src/relay-discovery.ts",
    from: "  for (const addr of addrs) assertPinnable(addr, url);",
    to: "  for (const addr of addrs.slice(0, -1)) assertPinnable(addr, url);",
    note: "FINAL-ITERATION",
  },
  {
    id: "R6  an empty address list is accepted",
    file: "src/relay-discovery.ts",
    from: "  if (!Array.isArray(addrs) || addrs.length === 0) {",
    to: "  if (!Array.isArray(addrs)) {",
    note: "'concluding the relay has no address is worse than an error'",
  },
  {
    id: "R7  a non-array relayAddrs is accepted",
    file: "src/relay-discovery.ts",
    from: "  if (!Array.isArray(addrs) || addrs.length === 0) {",
    to: "  if (addrs == null) {",
    note: "symmetric pair with R6",
  },
  {
    id: "R8  a non-200 response is not checked",
    file: "src/relay-discovery.ts",
    from: "  if (!response.ok) {",
    to: "  if (false as boolean) {",
    note: "a 404 means the relay is down",
  },
  {
    id: "R9  the multiaddr form is fetched instead of passed through",
    file: "src/relay-discovery.ts",
    from: '  if (relay.startsWith("/")) {',
    to: "  if (false as boolean) {",
    note: "local development has no document",
  },
  {
    id: "R10 the CORS hint is dropped from the fetch-failure message",
    file: "src/relay-discovery.ts",
    from: '        "From a browser, check that the relay serves it with Access-Control-Allow-Origin.",',
    to: '        "",',
    note: "the failure this comment exists to make searchable",
  },
  {
    id: "R11 the not-a-multiaddr check is removed",
    file: "src/relay-discovery.ts",
    from: '  if (typeof addr !== "string" || !addr.startsWith("/")) {',
    to: "  if (false as boolean) {",
    note: "a hostname would be accepted as an address",
  },
  {
    id: "R12 the document path becomes relative, so a URL path is honoured",
    file: "src/relay-discovery.ts",
    from: "  const url = new URL(RELAY_DOCUMENT_PATH, relay).toString();",
    to: "  const url = new URL(RELAY_DOCUMENT_PATH.slice(1), relay).toString();",
    note: "note 10 §6's recorded behaviour",
  },
];

const ONLY = process.env.ONLY ? process.env.ONLY.split(",") : null;
if (ONLY) {
  for (let i = MUTANTS.length - 1; i >= 0; i--) {
    if (!ONLY.some((o) => MUTANTS[i].id.startsWith(o.trim()))) MUTANTS.splice(i, 1);
  }
}

const originals = new Map();
for (const m of MUTANTS) {
  if (!originals.has(m.file)) originals.set(m.file, readFileSync(`${APP}/${m.file}`, "utf8"));
}
const restore = () => {
  for (const [f, text] of originals) writeFileSync(`${APP}/${f}`, text);
};

/**
 * RESTORE ON EVERY WAY OUT, not only a clean exit. `process.on("exit")` alone is
 * not enough, and that is not theoretical: piping this harness's output through
 * `head` closes stdout, the next `console.log` raises EPIPE / SIGPIPE, the
 * process dies WITHOUT running an exit handler, and whichever mutant was applied
 * at that moment is left on disk. It happened, the mutated file was committed,
 * and it was caught only by a byte-identity check against the mirror.
 *
 * So: the exit handler, every signal that can kill us, and `uncaughtException`.
 * Writing the originals back is idempotent, so running more than one of these is
 * harmless. `stdout` errors are swallowed for the same reason — a closed pipe
 * must not be what stops the restore.
 */
process.on("exit", restore);
process.stdout.on("error", () => {});
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP", "SIGPIPE"]) {
  process.on(signal, () => {
    restore();
    process.exit(1);
  });
}
process.on("uncaughtException", (err) => {
  restore();
  console.error(err);
  process.exit(1);
});

/** Run the unit suite. Returns `{ failed, tally, failing }`; `tally === null` means it never ran. */
function runUnits() {
  let out = "";
  let failed = false;
  try {
    out = execFileSync("npx", ["vitest", "run", "--no-file-parallelism", "--reporter=verbose"], {
      cwd: APP,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 300_000,
    });
  } catch (e) {
    failed = true;
    out = `${e.stdout ?? ""}${e.stderr ?? ""}`;
  }
  const failing = [...out.matchAll(/^\s*(?:×|✗|FAIL)\s+(.*)$/gm)].map((x) => x[1].trim());
  return { failed, tally: /Tests\s+(.*)$/m.exec(out)?.[1]?.trim() ?? null, failing };
}

/**
 * Run the ADOPTED integration harness — only ever for a mutant the unit suite
 * let through, to tell "uncovered" from "covered, but not by a unit test".
 */
function runIntegration() {
  let out = "";
  let failed = false;
  try {
    out = execFileSync("pnpm", ["run", "verify:node"], {
      cwd: APP,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 300_000,
    });
  } catch (e) {
    failed = true;
    out = `${e.stdout ?? ""}${e.stderr ?? ""}`;
  }
  const ran = /all claims hold|claim\(s\) failed/.test(out);
  const broke = [...out.matchAll(/^ {2}FAIL {2}(.*)$/gm)].map((x) => x[1].trim());
  return { failed, ran, broke };
}

// CONTROL: the unmutated tree must be green, and the tally must parse.
{
  const { failed, tally } = runUnits();
  console.log(
    `CONTROL        unmutated tree   [${tally ?? "TALLY DID NOT PARSE"}] ${failed ? "NOT GREEN" : "green"}`,
  );
  if (failed || tally == null) process.exit(1);
}

const results = [];
for (const m of MUTANTS) {
  const src = originals.get(m.file);
  const n = src.split(m.from).length - 1;
  if (n !== 1) {
    results.push({ ...m, verdict: `BAD-PATCH (${n} matches)`, tally: "", failing: [] });
    console.log(`?? ${m.id}: pattern matched ${n} times`);
    continue;
  }
  writeFileSync(`${APP}/${m.file}`, src.replace(m.from, m.to));

  const unit = runUnits();
  let verdict;
  let extra = "";
  if (unit.tally == null) {
    verdict = "HARNESS-ERROR";
  } else if (unit.failed) {
    verdict = "KILLED";
  } else {
    // Survived the unit suite — ask the adopted harness before calling it a gap.
    const int = runIntegration();
    if (!int.ran && !int.failed) {
      verdict = "SURVIVED";
      extra = " (integration harness inconclusive)";
    } else if (int.failed) {
      verdict = "SURVIVED-UNIT/KILLED-INT";
      extra = int.broke.length > 0 ? ` (${int.broke.slice(0, 3).join("; ")})` : "";
    } else {
      verdict = "SURVIVED-BOTH";
    }
  }
  restore();

  results.push({ ...m, verdict, tally: unit.tally ?? "(suite never ran)", failing: unit.failing });
  console.log(`${verdict.padEnd(14)} ${m.id}   [${unit.tally ?? "suite never ran"}]${extra}`);
  if (verdict === "KILLED") {
    for (const f of [...new Set(unit.failing)].slice(0, 4)) console.log(`               ${f}`);
  }
}

console.log("\n===== NOT KILLED BY THE UNIT SUITE =====");
const survivors = results.filter((r) => r.verdict !== "KILLED");
if (survivors.length === 0) console.log("(none)");
for (const r of survivors) console.log(`- ${r.verdict}  ${r.id}  (${r.note})`);

// A last word, because the restore above was not always enough: VERIFY. `git status`
// (or a diff against the read-only mirror) after a mutation run is the only thing
// that proves no mutant was left behind.
console.log("\nRun `git status` / diff against the mirror before committing.");
