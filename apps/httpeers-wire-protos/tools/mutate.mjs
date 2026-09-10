#!/usr/bin/env node
/**
 * The mutation harness for this app — §5.3 of
 * `notes/2026/2026-09/2026-09-09/[umbrella-next].prototype-adoption.md`, which requires a
 * mutation pass over every adopted unit: "a suite that has never been proven able to fail is
 * not evidence."
 *
 *     node tools/mutate.mjs              # every mutant
 *     ONLY="M4a,M6b" node tools/mutate.mjs
 *
 * Applies one mutation at a time by exact string replacement, runs `vitest run
 * --no-file-parallelism`, records KILLED / SURVIVED, and restores the file. The originals
 * are read once up front and rewritten after every run, including on `process.exit`, so an
 * interrupted run does not leave a mutated tree behind. Verify with `git status` anyway.
 *
 * TWO GUARDS, BOTH EARNED THE HARD WAY — keep them in any copy of this file:
 *
 *  1. AN UNMUTATED CONTROL RUNS FIRST and must be green with a parsable tally, or the
 *     harness exits before testing anything.
 *  2. A RUN WHOSE TALLY LINE DID NOT PARSE is reported as HARNESS-ERROR, never as KILLED.
 *
 * Without them this harness reported 27 mutants out of 27 killed, and the suite looked
 * perfect. The real cause was `--reporter=basic`, which does not exist in Vitest 4: every
 * run died loading the reporter, exited non-zero, and was scored as a kill. §5.4 of the work
 * order says to treat a first-run pass as suspicious rather than reassuring — that is the
 * instruction that caught this, and it caught it on the first clean sweep.
 *
 * A mutant that hangs rather than failing is KILLED by test timeout, but several hanging
 * files can exceed the per-run budget below and land as HARNESS-ERROR. Re-run that mutant
 * alone with ONLY= and a longer timeout before drawing any conclusion from it.
 *
 * Two mutation shapes are mandatory per §5.3, because each has already survived once in this
 * project: FINAL-ITERATION PATHS (does a test cover the last iteration as well as an early
 * one?) and SYMMETRIC PAIRS (is every send/receive, request/response, first/last pair
 * exercised on BOTH sides?). The M4a row below is a textbook symmetric pair: the client's
 * own HEAD rule masks the server's, so no assertion about the returned `Response` can see
 * the serving side at all.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The app root: this file lives in `<app>/tools/`. */
const APP = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** @type {{id:string,file:string,from:string,to:string,note:string}[]} */
const MUTANTS = [
  // ---- the two v1 show-stoppers: would this suite have caught them? ----
  {
    id: "M1  query dropped from the envelope url",
    file: "src/wire.ts",
    from: "  url: req.url,                              // FULL url -- query preserved",
    to: "  url: new URL(req.url).origin + new URL(req.url).pathname,",
    note: "v1 show-stopper, note 13",
  },
  {
    id: "M2  streamed request body never written",
    file: "src/wire.ts",
    from: "  if (body != null) {",
    to: "  if (false as boolean) {\n    body = body\n  } else if (false) {",
    note: "v1 show-stopper, note 14",
  },
  {
    id: "M2b request body buffered, not streamed",
    file: "src/wire.ts",
    from: `      if (value != null && value.byteLength > 0) await send(stream, value)
      if (done) break`,
    to: `      if (value != null && value.byteLength > 0) __buf.push(value)
      if (done) { for (const b of __buf) await send(stream, b); break }`,
    note: "buffer-then-flush: bytes all arrive, but not incrementally",
  },

  // ---- final-iteration paths ----
  {
    id: "M3  envelope spanning >1 wire chunk: leading parts dropped",
    file: "src/wire.ts",
    from: "    if (nl === -1) { parts.push(chunk); continue }",
    to: "    if (nl === -1) { continue }",
    note: "final-iteration: only the LAST scan iteration is kept",
  },
  {
    id: "M3b envelope reassembly skips the final part",
    file: "src/wire.ts",
    from: "  for (const p of parts) { head.set(p, off); off += p.byteLength }",
    to: "  for (const p of parts.slice(0, -1)) { head.set(p, off); off += p.byteLength }",
    note: "final-iteration of the reassembly loop",
  },
  {
    id: "M3c body pull drops the last chunk on the stream (done+value)",
    file: "src/wire.ts",
    from: "      if (next.done === true) { controller.close(); return }",
    to: "      if (next.done === true || next.value == null) { controller.close(); return }",
    note: "final-iteration: a chunk delivered together with done",
  },
  {
    id: "M3d first body chunk sharing the envelope's wire chunk is dropped",
    file: "src/wire.ts",
    from: `      if (tail.byteLength > 0) {
        controller.enqueue(tail)
        tail = new Uint8Array(0)
        return
      }`,
    to: `      if (tail.byteLength > 0) {
        tail = new Uint8Array(0)
      }`,
    note: "the tail path -- first iteration of the body, not the last",
  },

  // ---- symmetric pairs: null-body, both sides ----
  {
    id: "M4a SERVER half of the null-body pair removed",
    file: "src/transport-wire.ts",
    from: "        const sendBody = req.method !== 'HEAD' && !NULL_BODY_STATUS.has(res.status)",
    to: "        const sendBody = true",
    note: "symmetric pair: serving side only",
  },
  {
    id: "M4b CLIENT half loses its HEAD arm",
    file: "src/transport-wire.ts",
    from: "    const nullBody = req.method === 'HEAD' || NULL_BODY_STATUS.has(envelope.status)",
    to: "    const nullBody = NULL_BODY_STATUS.has(envelope.status)",
    note: "symmetric pair: client side, HEAD arm only",
  },
  {
    id: "M4c CLIENT half loses its status arm",
    file: "src/transport-wire.ts",
    from: "    const nullBody = req.method === 'HEAD' || NULL_BODY_STATUS.has(envelope.status)",
    to: "    const nullBody = req.method === 'HEAD'",
    note: "symmetric pair: client side, status arm only",
  },
  {
    id: "M4d 205 removed from NULL_BODY_STATUS",
    file: "src/transport-wire.ts",
    from: "const NULL_BODY_STATUS = new Set([101, 103, 204, 205, 304])",
    to: "const NULL_BODY_STATUS = new Set([101, 103, 204, 304])",
    note: "the exact bug robustness.test.ts was written to catch",
  },

  // ---- symmetric pairs: stream caps, inbound vs outbound ----
  {
    id: "M6a maxInboundStreams back to libp2p's default of 32",
    file: "src/transport-wire.ts",
    from: "    maxInboundStreams: init.maxInboundStreams ?? DEFAULT_MAX_STREAMS,",
    to: "    maxInboundStreams: init.maxInboundStreams ?? 32,",
    note: "symmetric pair: inbound",
  },
  {
    id: "M6b maxOutboundStreams reduced to 1",
    file: "src/transport-wire.ts",
    from: "    maxOutboundStreams: init.maxOutboundStreams ?? DEFAULT_MAX_STREAMS",
    to: "    maxOutboundStreams: init.maxOutboundStreams ?? 1",
    note: "symmetric pair: outbound",
  },

  // ---- symmetric pairs: request vs response envelope carriage ----
  {
    id: "M5a REQUEST headers dropped from the envelope",
    file: "src/wire.ts",
    from: "  headers: [...req.headers.entries()]",
    to: "  headers: []",
    note: "symmetric pair: request headers",
  },
  {
    id: "M5b RESPONSE headers dropped from the envelope",
    file: "src/transport-wire.ts",
    from: "          headers: [...res.headers.entries()]",
    to: "          headers: []",
    note: "symmetric pair: response headers",
  },
  {
    id: "M5c REQUEST method dropped (always GET)",
    file: "src/wire.ts",
    from: "  method: req.method,",
    to: "  method: 'GET',",
    note: "symmetric pair: request line",
  },
  {
    id: "M5d RESPONSE statusText dropped",
    file: "src/transport-wire.ts",
    from: "          statusText: res.statusText,",
    to: "          statusText: '',",
    note: "symmetric pair: response line",
  },
  {
    id: "M5e RESPONSE status forced to 200",
    file: "src/transport-wire.ts",
    from: "          status: res.status,",
    to: "          status: 200,",
    note: "symmetric pair: response line",
  },

  // ---- the rest of the mechanism ----
  {
    id: "M7  half-close removed (stream never closed for write)",
    file: "src/wire.ts",
    from: "  await stream.close()",
    to: "  await Promise.resolve()",
    note: "the mechanism the whole rung rests on",
  },
  {
    id: "M8  backpressure: onDrain never awaited",
    file: "src/wire.ts",
    from: "  if (!stream.send(bytes)) await stream.onDrain()",
    to: "  stream.send(bytes)",
    note: "R2's stated subject",
  },
  {
    id: "M9  proven peer id replaced by a constant",
    file: "src/transport-wire.ts",
    from: "        registerPeer(req, connection.remotePeer.toString())",
    to: "        registerPeer(req, 'not-the-real-peer')",
    note: "identity",
  },
  {
    id: "M10 GET/HEAD body suppression removed on the server",
    file: "src/wire.ts",
    from: "  body: env.method === 'GET' || env.method === 'HEAD' ? null : body,",
    to: "  body: body,",
    note: "fromEnvelope",
  },
  {
    id: "M11 handler error swallowed instead of aborting the stream",
    file: "src/transport-wire.ts",
    from: "        try { stream.abort(err as Error) } catch { /* already gone */ }",
    to: "        void err",
    note: "B4's subject",
  },
  {
    id: "M12 runOnLimitedConnection dropped on the serving side",
    file: "src/transport-wire.ts",
    from: "    runOnLimitedConnection: true,",
    to: "    runOnLimitedConnection: false,",
    note: "relay-only path",
  },
  {
    id: "M13 runOnLimitedConnection dropped on the dialing side",
    file: "src/transport-wire.ts",
    from: `      runOnLimitedConnection: true
    })`,
    to: `      runOnLimitedConnection: false
    })`,
    note: "relay-only path, other side",
  },
  {
    id: "M14 empty-chunk skip removed from the envelope scan",
    file: "src/wire.ts",
    from: "    if (chunk.byteLength === 0) continue",
    to: "    void chunk",
    note: "defensive branch",
  },
  {
    id: "M15 zero-length body chunks are forwarded rather than skipped",
    file: "src/wire.ts",
    from: "      if (value != null && value.byteLength > 0) await send(stream, value)",
    to: "      if (value != null) await send(stream, value)",
    note: "defensive branch",
  },
];

const ONLY = process.env.ONLY ? process.env.ONLY.split(",") : null;
if (ONLY) {
  for (let i = MUTANTS.length - 1; i >= 0; i--)
    if (!ONLY.some((o) => MUTANTS[i].id.startsWith(o))) MUTANTS.splice(i, 1);
}
const originals = new Map();
for (const m of MUTANTS) {
  if (!originals.has(m.file)) originals.set(m.file, readFileSync(`${APP}/${m.file}`, "utf8"));
}
const restore = () => {
  for (const [f, text] of originals) writeFileSync(`${APP}/${f}`, text);
};
process.on("exit", restore);

const results = [];
{
  // CONTROL: the unmutated tree must be green, and the tally must parse.
  let out = "",
    ok = true;
  try {
    out = execFileSync("npx", ["vitest", "run", "--no-file-parallelism", "--reporter=verbose"], {
      cwd: APP,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 300_000,
    });
  } catch (e) {
    ok = false;
    out = `${e.stdout ?? ""}${e.stderr ?? ""}`;
  }
  const tally = /Tests\s+(.*)$/m.exec(out)?.[1]?.trim() ?? null;
  console.log(
    `CONTROL       unmutated tree   [${tally ?? "TALLY DID NOT PARSE"}] ${ok ? "green" : "NOT GREEN"}`,
  );
  if (!ok || tally == null) {
    console.log(out.slice(-3000));
    process.exit(1);
  }
}
for (const m of MUTANTS) {
  const src = originals.get(m.file);
  const n = src.split(m.from).length - 1;
  if (n !== 1) {
    results.push({ ...m, verdict: `BAD-PATCH (${n} matches)`, tally: "", failing: [] });
    console.log(`?? ${m.id}: pattern matched ${n} times`);
    continue;
  }
  let mutated = src.replace(m.from, m.to);
  if (m.id.startsWith("M2b")) {
    mutated = mutated.replace(
      "    const reader = body.getReader()",
      "    const __buf: Uint8Array[] = []\n    const reader = body.getReader()",
    );
  }
  writeFileSync(`${APP}/${m.file}`, mutated);

  let out = "";
  let killed = false;
  try {
    out = execFileSync("npx", ["vitest", "run", "--no-file-parallelism", "--reporter=verbose"], {
      cwd: APP,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 300_000,
    });
  } catch (e) {
    killed = true;
    out = `${e.stdout ?? ""}${e.stderr ?? ""}`;
  }
  restore();

  const failing = [...out.matchAll(/^\s*(?:×|✗|FAIL)\s+(.*)$/gm)].map((x) => x[1].trim());
  const tally = /Tests\s+(.*)$/m.exec(out)?.[1]?.trim() ?? null;
  const verdict = tally == null ? "HARNESS-ERROR" : killed ? "KILLED" : "SURVIVED";
  results.push({
    ...m,
    verdict,
    tally: tally ?? "(suite never ran)",
    failing: [...new Set(failing)].slice(0, 8),
  });
  console.log(`${verdict.padEnd(13)} ${m.id}   [${tally ?? "suite never ran"}]`);
  if (verdict === "KILLED")
    for (const f of [...new Set(failing)].slice(0, 6)) console.log(`             ${f}`);
}

console.log("\n===== SURVIVORS =====");
for (const r of results.filter((r) => r.verdict !== "KILLED")) {
  console.log(`- ${r.verdict}  ${r.id}  (${r.note})`);
}
