/**
 * Task 15 — leg 2 of the design record's §10 verification, and the first time
 * in this project's record that A BROWSER PEER SERVES ANOTHER BROWSER PEER.
 * Two real pages, in a real browser, over a real relay: the image peer page
 * (`src/pages/image-peer/`) provides, the app page (`src/pages/app/`)
 * consumes, and every hop between them — the ServiceWorker edge on both
 * sides, the WebRTC connection, the circuit reservation — is the production
 * one.
 *
 * PLAYWRIGHT RUNS INSIDE VITEST, NOT AS A SECOND RUNNER. `pnpm test` stays
 * the single entry point (the convention the W3 spec set and every suite in
 * this app follows), the whole file runs under `--no-file-parallelism`
 * against real ports, and the browser is launched and closed by ordinary
 * `beforeAll`/`afterAll` hooks.
 *
 * EVERY BROWSER CONSOLE LINE AND PAGE ERROR IS FORWARDED TO THIS PROCESS
 * (note 20 §5). Without it a browser-side failure is invisible and the whole
 * suite simply times out with nothing to read; with it, the page's own
 * `console.error` from `startBrowserPeer`'s catch lands in the vitest output
 * next to the assertion that failed.
 *
 * SINCE TASK 28 IT ALSO COVERS RESUMING. Both pages persist a libp2p
 * identity in their origin's IndexedDB, so a reload is not a new peer: it is
 * the same peer coming back, and it must come back WITHOUT redeeming the
 * (now spent) invitation still sitting in its URL. That reload is the one
 * thing in this task that no Node test can reach -- it needs a real
 * IndexedDB surviving a real navigation -- so it is asserted here.
 *
 * THE PAGES ARE BUILT BY THIS FILE, EVERY RUN. `dist/app` and
 * `dist/image-peer` are what the static server serves, and a stale bundle is
 * a silent failure: it looks like a passing suite testing code that is no
 * longer in the tree. The builds take ~200 ms each, which is far less than
 * the cost of ever being wrong about this.
 *
 * BROWSER FAILURES ARE FINDINGS, NEVER SKIPS. Both Chromium and Firefox run
 * the same describe block; if one of them cannot do this, the report says
 * exactly what failed and where. There is no `test.skip` in this file and
 * there must never be one — a green suite that quietly stopped running
 * Firefox is worse than a red one.
 *
 * TEST ORDER IS LOAD-BEARING, exactly as in leg 1. Two of these tests make
 * one-way transitions of shared state: closing the image peer's page (its
 * advertisement never comes back) and revoking the app page's membership
 * (every later call from it is refused). Each test that depends on an earlier
 * one says so.
 *
 * WHAT THIS FILE FOUND, AND WHY THE PRODUCTION DIFF IS BIGGER THAN A TEST
 * FILE. A page calling ANOTHER PAGE returned `peer-unreachable` every single
 * time, while a Node peer calling that same browser provider over the same
 * relay got a 200 — nothing had ever exercised the browser-to-browser
 * direction, in any suite, ever. See `src/browser/edge-dispatch.ts`'s job 4
 * and `src/browser/join.ts`'s `createRouteEnsurer` for the diagnosis and the
 * fix. The `<img>` gallery test below is the regression test for it.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Browser, BrowserType, Page } from "playwright";
import { chromium, firefox } from "playwright";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { HEARTBEAT_INTERVAL_MS } from "../../src/browser/join.js";
import { SWEEP_INTERVAL_MS } from "../../src/hub/main.js";
import type { StaticServers } from "../../src/static-server/main.js";
import { startStaticServer } from "../../src/static-server/main.js";
import type { Stack, StackPeer } from "./harness.js";
import { startStack } from "./harness.js";

const appRoot = fileURLToPath(new URL("../../", import.meta.url));

/**
 * The hub's presence TTL for this leg. Comfortably above
 * `HEARTBEAT_INTERVAL_MS` (5 s), which a page has no knob for — leg 1's 2 s
 * would sweep a page between its own beats and the mesh would flap for
 * reasons unrelated to anything under test. See `harness.ts`'s
 * `StartStackInit`.
 */
const PRESENCE_TTL_MS = HEARTBEAT_INTERVAL_MS + 3_000;

/**
 * Bytes per `files.read` call on the PROVIDER PAGE, via its `?chunk=`
 * parameter. The fixture PNGs are ~370 bytes and the endpoint's own default
 * is 64 KiB, so without this every image is served in exactly one chunk and
 * "arrives in more than one chunk" is unobservable — see
 * `src/pages/image-peer/pacing.ts`.
 */
const PROVIDER_CHUNK_SIZE = 64;

/**
 * How long the provider page stalls before yielding each chunk, via its
 * `?delay=` parameter. This is what the streaming assertion measures, and
 * the whole reason it can tell streaming from buffering at all: see
 * `assertStreamed` below.
 */
const PROVIDER_CHUNK_DELAY_MS = 40;

/** The fixture the streaming test reads. 361 bytes, so 5 full 64-byte chunks and a 41-byte tail. */
const STREAMED_IMAGE_ID = "relay-node";

/** A peer that serves nothing: no policy at all, so deny by default answers everything. What the app page itself runs. */
const SERVES_NOTHING: readonly string[] = [];

/** A query the hub's fixture set answers with at least one result (`src/services/search-fixtures.json`). */
const SEARCH_QUERY = "relay";

/**
 * Per-test bound. Generous, and NOT a policy about how long a mesh call may
 * take (that is T-2's, see `waitForState`): it is vitest's own bound on a
 * test body, which here contains real browser navigation, real ICE
 * negotiation and — in one case — a wait for the hub's TTL sweep. Every
 * assertion inside is reached long before this; a test that hits it has hung,
 * and the forwarded page output above it is what says why.
 */
const TEST_TIMEOUT_MS = 90_000;

/**
 * Wait until `check` returns true, polling every 100 ms.
 *
 * THIS IS NOT A CALL TIMEOUT AND MUST NOT BECOME ONE — leg 1 makes the same
 * distinction and it holds identically here. T-2 owns the only bound on a
 * peer call (`DEFAULT_REQUEST_TIMEOUT_MS`, `transport-duplex.ts`) and this
 * file adds no second one. What this bounds is a wait for BROWSER OR MESH
 * STATE to arrive — a ServiceWorker to activate, an advertisement to leave
 * the hub's view, a page's own poll to repaint — none of which is a request,
 * and all of which are driven by timers this test does not control.
 */
async function waitForState(
  label: string,
  budgetMs: number,
  check: () => Promise<boolean>,
): Promise<number> {
  const startedAt = performance.now();
  for (;;) {
    if (await check()) return performance.now() - startedAt;
    const elapsed = performance.now() - startedAt;
    if (elapsed > budgetMs) {
      throw new Error(
        `${label}: still not true after ${elapsed.toFixed(0)}ms (budget ${budgetMs}ms)`,
      );
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
}

/**
 * Forward everything the page says to this process — see the module comment.
 *
 * `msg.text()` IS NOT ENOUGH, and the difference is the whole point of doing
 * this at all. A page that logs `console.error("failed:", err)` renders the
 * Error argument as the bare string `Error` in `msg.text()` — no message, no
 * stack, no cause. Every argument is therefore resolved IN THE PAGE, where
 * the object still exists, down to its own `stack` (and `cause`, which is
 * where `peer-runtime.ts` puts the libp2p failure that actually explains a
 * join that did not happen).
 *
 * WARNINGS ARE KEPT, NOT ONLY ERRORS. `edge-dispatch.ts` deliberately
 * SWALLOWS a failed `ensureRoute` dial (job 4: rethrowing would replace
 * T-2's typed `kind` with an untyped 500) and its `console.warn` is then the
 * only record that a route could not be established at all. Keeping only
 * `error` would print that one line and drop it from the failure — the exact
 * "diagnosable failure vs. an afternoon" difference this forwarding exists
 * for. Nothing in a healthy run warns, so the cost is zero when it is not
 * needed.
 */
function forwardPageOutput(label: string, page: Page, faults: string[]): void {
  page.on("console", (msg) => {
    void Promise.all(
      msg.args().map((arg) =>
        arg
          .evaluate((value: unknown) => {
            if (!(value instanceof Error)) return String(value);
            const cause = (value as { cause?: unknown }).cause;
            // `name: message` FIRST, and explicitly: V8's `stack` starts
            // with it, SpiderMonkey's does not, so printing only `stack`
            // loses the message entirely in Firefox — which is the browser
            // most likely to be the one failing.
            return (
              `${value.name}: ${value.message}\n${value.stack ?? "(no stack)"}` +
              (cause != null ? `\n  caused by: ${String(cause)}` : "")
            );
          })
          .catch(() => msg.text()),
      ),
    )
      .then((parts) => {
        const text = parts.length > 0 ? parts.join(" ") : msg.text();
        // Kept as well as printed: the beforeAll that gives up on a page
        // quotes these, so the reason lands IN the failure rather than
        // several hundred lines above it.
        if (msg.type() === "error" || msg.type() === "warning") {
          faults.push(`[${label}:${msg.type()}] ${text}`);
        }
        console.log(`[${label}:${msg.type()}] ${text}`);
      })
      .catch(() => {
        console.log(`[${label}:${msg.type()}] ${msg.text()}`);
      });
  });
  page.on("pageerror", (err) => {
    faults.push(`[${label}] uncaught ${err.name}: ${err.message}`);
    console.log(`[${label}:pageerror] ${err.stack ?? err.message}`);
  });
  page.on("requestfailed", (req) => {
    console.log(`[${label}:requestfailed] ${req.url()} — ${req.failure()?.errorText ?? "?"}`);
  });
  page.on("crash", () => {
    console.log(`[${label}:crash] the page crashed`);
  });
}

/** `#peer-id`'s text, once the page has one. */
async function peerIdOfPage(page: Page): Promise<string> {
  return (await page.textContent("#peer-id"))!.trim();
}

/**
 * The peer id the app page is currently showing for a provider of `kind`.
 * Parsed out of the rendered line (`discovery.ts`'s `describeProvider`:
 * `images: Images — 12D3Koo…`) rather than out of anything this test
 * configured — which is the point: the test knows the provider's id only
 * because the page discovered it and rendered it.
 */
async function renderedProviderPeerId(page: Page, kind: "search" | "images"): Promise<string> {
  const text = (await page.textContent(`#${kind}-provider`))!;
  const [, peerId] = text.split("—");
  return (peerId ?? "").trim();
}

interface StreamedBody {
  status: number;
  sizes: number[];
  /** Milliseconds after the fetch was issued, on the CONSUMER page's own clock. */
  arrivedAt: number[];
  bytes: number[];
}

/**
 * Fetches `path` from inside the app page and reads the response through
 * `response.body.getReader()`, recording every chunk's size and arrival
 * time. `.arrayBuffer()` would hide both.
 *
 * THE URL IS COMPOSED BY THE PAGE, FROM `#base-url` — the same
 * `${baseUrl}${peerId}/…` composition `main.ts` itself uses, and the single
 * riskiest untested line in Task 13: it is what proves the ServiceWorker
 * prefix strip, the runtime's token attachment and the router's peer-prefix
 * routing all agree, in one call.
 */
async function fetchStreamed(page: Page, peerId: string, path: string): Promise<StreamedBody> {
  return page.evaluate(
    async ([target, suffix]) => {
      const baseUrl = document.querySelector("#base-url")!.textContent!;
      const issuedAt = performance.now();
      const res = await fetch(`${baseUrl}${target}${suffix}`);
      const sizes: number[] = [];
      const arrivedAt: number[] = [];
      const parts: Uint8Array[] = [];
      const reader = res.body!.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        arrivedAt.push(performance.now() - issuedAt);
        sizes.push(value.length);
        parts.push(value);
      }
      const total = sizes.reduce((a, b) => a + b, 0);
      const bytes = new Uint8Array(total);
      let offset = 0;
      for (const part of parts) {
        bytes.set(part, offset);
        offset += part.length;
      }
      return { status: res.status, sizes, arrivedAt, bytes: Array.from(bytes) };
    },
    [peerId, path] as const,
  );
}

/** Everything one browser's run owns. */
interface Session {
  browser: Browser;
  appPage: Page;
  imagePage: Page;
  stack: Stack;
  servers: StaticServers;
  configDir: string;
  /** Joined lazily by the revocation test — a Node peer holding `std:mesh.admin`, which neither page does. */
  admin?: StackPeer;
  /** Every `console.error`, `console.warn` and uncaught exception either page produced, newest last. Quoted verbatim by a failure. */
  faults: string[];
}

/** Built once for the whole file, not once per browser. */
let pagesBuilt = false;
function buildPages(): void {
  if (pagesBuilt) return;
  // All THREE pages. The hub page was missing from this list, so nothing in
  // the suite ever built it and a broken `dist/hub` was invisible here.
  for (const config of ["vite.app.config.ts", "vite.image-peer.config.ts", "vite.hub.config.ts"]) {
    execFileSync("pnpm", ["exec", "vite", "build", "--config", config], {
      cwd: appRoot,
      stdio: "pipe",
    });
  }
  pagesBuilt = true;
}

/** Everything the app origin actually ships, concatenated — `index.html`, the hashed entry chunk(s) and `sw.js`. */
function distAppSources(): string {
  const dir = join(appRoot, "dist/app");
  const assets = join(dir, "assets");
  return [
    readFileSync(join(dir, "index.html"), "utf8"),
    readFileSync(join(dir, "sw.js"), "utf8"),
    ...readdirSync(assets).map((file) => readFileSync(join(assets, file), "utf8")),
  ].join("\n");
}

/**
 * Boot everything one browser's run needs, and unwind ALL of it if any step
 * fails.
 *
 * THE UNWIND IS NOT TIDINESS. `afterAll` can only stop what `beforeAll`
 * assigned, so a throw between `launcher.launch()` and the last `goto` used
 * to leave a browser process, two HTTP servers and a whole relay+hub mesh
 * running with no handle to any of them — `session` is never assigned and
 * `stopSession`'s own `session == null` guard skips the lot. Playwright's
 * exit handlers usually mop the browser up, so it presents as noise rather
 * than a hang, which is exactly why it would go unnoticed. Same shape
 * `startBrowserPeer` and `startHub` already use for the same reason.
 */
async function startSession(launcher: BrowserType): Promise<Session> {
  buildPages();

  const unwind: Array<() => Promise<void>> = [];
  const startFailed = async (): Promise<void> => {
    // A COPY: `reverse()` mutates in place, and unwinding twice off the same
    // array would run the steps forwards the second time — the same note
    // `peer-runtime.ts` carries.
    for (const step of [...unwind].reverse()) {
      await step().catch((err: unknown) => {
        console.log(`[session] error while unwinding a failed start: ${String(err)}`);
      });
    }
  };

  try {
    return await buildSession(launcher, unwind);
  } catch (err) {
    await startFailed();
    throw err;
  }
}

async function buildSession(
  launcher: BrowserType,
  unwind: Array<() => Promise<void>>,
): Promise<Session> {
  const stack = await startStack({ presenceTtlMs: PRESENCE_TTL_MS });
  unwind.push(async () => await stack.stop());

  // The invitation payload both pages fetch over HTTP. Written for real,
  // to a real file, and served by the real static server — `pnpm bootstrap`'s
  // own output shape (`src/setup/main.ts`'s `HttpeersConfig`), with this
  // stack's actual relay address in it.
  const configDir = mkdtempSync(join(tmpdir(), "httpeers-browser-e2e-"));
  unwind.push(async () => rmSync(configDir, { recursive: true, force: true }));
  const httpeersConfigPath = join(configDir, "httpeers.json");
  writeFileSync(
    httpeersConfigPath,
    `${JSON.stringify({ relayAddrs: [stack.relayAddr], hubPeerId: stack.hubPeerId }, null, 2)}\n`,
  );

  // PORT 0, NOT 5175/5176. Two ephemeral ports are still two ORIGINS, which
  // is the property the static server's own comment says is load-bearing
  // (one ServiceWorker scope and one adapter key each); the fixed numbers
  // are not, and a suite that binds them fails on any machine already
  // running `pnpm start`.
  const servers = await startStaticServer({
    appPort: 0,
    imagePeerPort: 0,
    // Ephemeral like its two siblings. Without this the third origin falls back
    // to HUB_PAGE_PORT and this suite starts depending on 5177 being free --
    // breaking the invariant stated at the top of static-server.test.ts, and
    // failing with EADDRINUSE whenever a `pnpm start` happens to be running.
    hubPagePort: 0,
    appDistDir: join(appRoot, "dist/app"),
    imagePeerDistDir: join(appRoot, "dist/image-peer"),
    httpeersConfigPath,
  });
  unwind.push(async () => await servers.stop());

  const browser = await launcher.launch({ headless: true });
  unwind.push(async () => await browser.close());
  const context = await browser.newContext();

  const faults: string[] = [];
  const imagePage = await context.newPage();
  forwardPageOutput("image-peer", imagePage, faults);
  const appPage = await context.newPage();
  forwardPageOutput("app", appPage, faults);

  // Two invitations, minted through the hub's own store — the same call
  // `InvitationStore.create` (`../../src/hub/persist.ts`) that a real
  // operator would need, since there is no HTTP endpoint for it (see
  // `src/pages/image-peer/main.ts`'s module comment) — and the only way
  // into this mesh. Each page takes its own from `?invite=`; there is no
  // other source in this codebase.
  const imageInvite = stack.invite(["member"]);
  const appInvite = stack.invite(["member"]);

  const imageUrl =
    `http://127.0.0.1:${servers.imagePeerPort}/?invite=${imageInvite}` +
    `&chunk=${PROVIDER_CHUNK_SIZE}&delay=${PROVIDER_CHUNK_DELAY_MS}`;
  await imagePage.goto(imageUrl);
  await appPage.goto(`http://127.0.0.1:${servers.appPort}/?invite=${appInvite}`);

  return { browser, appPage, imagePage, stack, servers, configDir, faults };
}

/**
 * Stop everything, in the order that produces the fewest lies: the browser
 * first (a page still heartbeating while the hub goes down logs a failure
 * belonging to nothing), then the servers, then the mesh, then the temp dir.
 *
 * EVERY STEP IS ATTEMPTED EVEN IF AN EARLIER ONE THREW, and no failure is
 * silent. Swallowing them keeps a leak from failing the run — a leak here
 * presents as a vitest hang, and a hang whose cause was caught and discarded
 * is the worst of both. None has been observed; the log line is what makes
 * the first one visible.
 */
async function stopSession(session: Session | undefined): Promise<void> {
  if (session == null) return;
  const steps: Array<[string, () => Promise<void>]> = [
    ["browser", async () => await session.browser.close()],
    ["static servers", async () => await session.servers.stop()],
    ["relay + hub", async () => await session.stack.stop()],
    ["config dir", async () => rmSync(session.configDir, { recursive: true, force: true })],
  ];
  for (const [what, step] of steps) {
    await step().catch((err: unknown) => {
      console.log(`[teardown] stopping the ${what} failed: ${String(err)}`);
    });
  }
}

/**
 * The streaming assertion, and the only part of this file whose reasoning
 * has to be read carefully.
 *
 * COUNTING CHUNKS DOES NOT PROVE STREAMING. A transport that buffered the
 * whole body and re-enqueued it in identical pieces would produce the same
 * count and the same sizes; leg 1's reviewer demonstrated exactly that. So
 * `response.body.getReader()` is necessary and nowhere near sufficient.
 *
 * AND LEG 1'S TIMING COMPARISON CANNOT BE COPIED HERE. That one asserts
 * "chunk k arrived before chunk k+1 was SENT", comparing a consumer
 * timestamp against a provider timestamp — sound there because both are
 * `performance.now()` in ONE process. Here the provider and the consumer are
 * separate browsing contexts with separate `performance.timeOrigin`, so the
 * same shape would measure the clock offset between two pages and pass or
 * fail for reasons having nothing to do with buffering. That is worse than
 * no assertion, because it looks like one.
 *
 * WHAT IS ASSERTED INSTEAD, ALL ON THE CONSUMER'S OWN CLOCK: the provider
 * stalls `PROVIDER_CHUNK_DELAY_MS` before each chunk, so a STREAMING
 * transport delivers chunk k at roughly `k * delay` — the arrivals are
 * SPREAD, with the gaps between them real. A BUFFERING transport cannot
 * produce that shape whatever it does with chunk boundaries: it has nothing
 * to hand over until the provider has finished producing, so every chunk
 * arrives in one burst at the end and the gaps collapse to ~0.
 *
 * FALSIFIED, NOT ASSUMED. The mutant — `createImagesEndpoint` draining its
 * own `ReadableStream` into memory and re-enqueuing the identical chunk
 * sizes with a 2ms release stall — was built and run against BOTH
 * assertions below, in both browsers, twice (once at Task 15, once again
 * in this task's fix round after the assertions changed): count and sizes
 * still pass, both timing assertions still fail, by a wide margin every
 * time.
 *
 * A THIRD ASSERTION WAS TRIED AND DELIBERATELY DROPPED. "The first chunk
 * arrived before half the total time had passed" (comparing `arrivedAt[0]`
 * against `arrivedAt.at(-1)`) sounds like a natural third proof, and an
 * earlier version of this function had it. It does not survive contact with
 * a second browser: it needs a per-request baseline (dial + ServiceWorker
 * round trip) subtracted out first, since that cost lands on both
 * timestamps and pushes the ratio toward 1 as it grows, independent of
 * streaming behaviour. The obvious way to measure that baseline — how long
 * `fetch()` itself takes to resolve, before any body byte is read — turns
 * out not to mean the same thing in both browsers: in Chromium it is
 * headers-received, strictly before any chunk; in Firefox, measured
 * directly, `fetch()` did not resolve until the FIRST BODY CHUNK was
 * already available (`headersAt` landed exactly on `arrivedAt[0]`, every
 * time, real traffic or mutant). Subtracting it there does not remove a
 * fixed cost — it zeroes the numerator outright, so the "corrected"
 * assertion passed against the buffering mutant too, unconditionally, in
 * Firefox only. That is precisely the outcome the top of this comment
 * calls "worse than no assertion, because it looks like one" — so rather
 * than ship a check that quietly stops testing anything in one browser,
 * it is gone. The two assertions below were re-verified alone against the
 * mutant, in both browsers, and remain sufficient: real, evenly-spread
 * per-chunk gaps make one arrival early relative to the rest as a matter of
 * arithmetic, so this loses no coverage the first two did not already
 * carry.
 */
function assertStreamed(streamed: StreamedBody, expectedBytes: Uint8Array): void {
  expect(streamed.status).toBe(200);
  expect(new Uint8Array(streamed.bytes)).toEqual(expectedBytes);

  // More than one chunk, and the sizes are the provider's own windowed
  // reads rather than whatever the transport felt like framing.
  expect(streamed.sizes.length).toBeGreaterThan(1);
  const expectedSizes: number[] = [];
  for (let sent = 0; sent < expectedBytes.length; sent += PROVIDER_CHUNK_SIZE) {
    expectedSizes.push(Math.min(PROVIDER_CHUNK_SIZE, expectedBytes.length - sent));
  }
  expect(streamed.sizes).toEqual(expectedSizes);

  const first = streamed.arrivedAt[0]!;
  const last = streamed.arrivedAt.at(-1)!;
  const gaps = streamed.arrivedAt.slice(1).map((at, i) => at - streamed.arrivedAt[i]!);

  // 1. The arrivals are spread across at least half the time the provider
  //    spent producing them. A burst delivery scores ~0 here. `last - first`
  //    is a difference of two same-clock timestamps, so any fixed setup
  //    cost common to both (the dial, the ServiceWorker round trip) cancels
  //    out on its own -- this assertion needs no correction for it, and
  //    under CPU contention this is the one of the three that has never
  //    been observed to flake (a review round measured it directly).
  expect(last - first).toBeGreaterThan((streamed.sizes.length - 1) * PROVIDER_CHUNK_DELAY_MS * 0.5);

  // 2. The TYPICAL gap is a real gap -- the MEDIAN, not every individual
  //    one. A review round caught this failing per-gap under CPU
  //    contention (observed: 11 ms and 8 ms against the original 20 ms
  //    floor, in two independent runs): the consumer can be descheduled
  //    for long enough that two already-stalled chunks get drained
  //    together on the next turn, collapsing ONE gap while the rest stay
  //    at ~40 ms -- real streaming, momentarily starved, not buffering.
  //    The median tolerates a minority of such collapses (with 5 gaps here,
  //    up to 2 can be arbitrarily low without moving it) while a genuinely
  //    buffered burst -- EVERY gap near 0, not just one -- still fails it
  //    the same way it always did: falsified against the drain-and-re-enqueue
  //    mutant (see the module comment above) with the SAME 20 ms floor, not
  //    a loosened one.
  const sortedGaps = [...gaps].sort((a, b) => a - b);
  const medianGap = sortedGaps[Math.floor(sortedGaps.length / 2)]!;
  expect(medianGap).toBeGreaterThan(PROVIDER_CHUNK_DELAY_MS * 0.5);
}

const BROWSERS = [
  { name: "chromium", launcher: chromium },
  { name: "firefox", launcher: firefox },
];

describe.each(BROWSERS)("Task 15: two browser peers in $name", ({ name, launcher }) => {
  let session: Session;

  beforeAll(async () => {
    session = await startSession(launcher);

    // Both pages have a lot to do before they are usable: fetch the config,
    // build a libp2p node, dial the relay, wait for a reservation, redeem an
    // invitation, register a ServiceWorker. A wait for THAT — page state, on
    // the page's own timers — not for any call. See `waitForState`.
    const elapsed = await waitForState(`${name}: both pages reach "ready"`, 60_000, async () => {
      const [image, app] = await Promise.all([
        session.imagePage.textContent("#state"),
        session.appPage.textContent("#state"),
      ]);
      if (image === "error" || app === "error") {
        // The page's own error, IN the failure. A `state` of "error" with
        // "see the console above" attached is exactly the unreadable outcome
        // the forwarding exists to prevent.
        throw new Error(
          `${name}: a page reported state "error" (image-peer=${image}, app=${app}).\n` +
            `Page errors and warnings, newest last:\n` +
            `${session.faults.join("\n") || "(none captured)"}`,
        );
      }
      return image === "ready" && app === "ready";
    });
    console.log(`[${name}] both pages ready in ${elapsed.toFixed(0)}ms`);
  }, 180_000);

  afterAll(async () => {
    await stopSession(session);
  }, 60_000);

  /**
   * On a FAILING test, quote what the pages said.
   *
   * The `beforeAll` already does this for a page that never came up, but the
   * failure most in need of it is a later one — a mesh call that came back
   * 502 while `edge-dispatch.ts`'s job 4 SWALLOWED the dial error that
   * explains it and left only a `console.warn` behind. Printed output is
   * hundreds of lines away from an assertion by the time vitest renders the
   * summary; this puts it underneath.
   */
  afterEach((ctx) => {
    if (ctx.task.result?.state !== "fail") return;
    if (session?.faults.length) {
      console.log(
        `[${name}] page errors and warnings captured before this failure:\n` +
          session.faults.join("\n"),
      );
    }
  });

  it(
    "each page is controlled by its own ServiceWorker edge",
    async () => {
      // `mountEdge` END TO END. Task 13 found `SwHttpAdapter`'s defaults
      // mutually recursive — the constructor blew the stack — which means this
      // path had never successfully executed anywhere, in any environment. The
      // fix was verified by reading the recursion and reproducing it; "it now
      // constructs" is not "it now works". This is the assertion that says it
      // works: a registered, ACTIVATED worker that is actually controlling the
      // page, on both origins.
      for (const [label, page] of [
        ["app", session.appPage],
        ["image-peer", session.imagePage],
      ] as const) {
        const sw = await page.evaluate(async () => {
          const registration = await navigator.serviceWorker.ready;
          return {
            controlled: navigator.serviceWorker.controller != null,
            controllerUrl: navigator.serviceWorker.controller?.scriptURL ?? null,
            activeState: registration.active?.state ?? null,
            scope: registration.scope,
          };
        });
        expect(sw.controlled, `${label}: page is controlled`).toBe(true);
        expect(sw.controllerUrl, `${label}: controller script`).toMatch(/\/sw\.js$/);
        expect(sw.activeState, `${label}: worker state`).toBe("activated");
        // `Service-Worker-Allowed: /` (the static server sets it) is what lets
        // a worker at `/sw.js` claim the whole origin.
        expect(sw.scope, `${label}: scope`).toMatch(/\/$/);
      }

      // The edge's own mount point, which every mesh call is composed from.
      // `/app/` — never `/` — because the ServiceWorker keys its channel
      // lookup on the first path segment (`edge-guard.ts`).
      expect(await session.appPage.textContent("#base-url")).toBe(
        `http://127.0.0.1:${session.servers.appPort}/app/`,
      );
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "both pages RESUME across a reload -- same peer id, and the spent invitation in the URL is not retried",
    async () => {
      // TASK 28'S CENTRAL CLAIM, IN THE ONLY PLACE IT CAN ACTUALLY BE
      // CHECKED. Both pages were opened with `?invite=`, which a reload
      // keeps in the URL -- and that invitation is now SPENT. Until Task 28
      // this reload failed `already-redeemed` and the page never came back;
      // now the page resumes its membership before redemption is ever
      // reached, so the spent invitation is simply not used.
      //
      // The identity is what makes that possible, and the peer id is how it
      // is observed: same key out of the same IndexedDB, therefore the same
      // peer id, therefore a peer the hub still lists as a member. A page
      // that had quietly minted a new identity would come back with a
      // different id and a fresh redemption -- which is exactly what this
      // assertion would catch.
      const before = {
        app: await peerIdOfPage(session.appPage),
        image: await peerIdOfPage(session.imagePage),
      };

      await Promise.all([session.appPage.reload(), session.imagePage.reload()]);

      const elapsed = await waitForState(`${name}: both pages resume`, 60_000, async () => {
        const [image, app] = await Promise.all([
          session.imagePage.textContent("#state"),
          session.appPage.textContent("#state"),
        ]);
        if (image === "error" || app === "error") {
          throw new Error(
            `${name}: a page reported state "error" after reload (image-peer=${image}, ` +
              `app=${app}).\nPage errors and warnings, newest last:\n` +
              `${session.faults.join("\n") || "(none captured)"}`,
          );
        }
        return image === "ready" && app === "ready";
      });
      console.log(`[${name}] both pages resumed in ${elapsed.toFixed(0)}ms`);

      expect(await peerIdOfPage(session.appPage)).toBe(before.app);
      expect(await peerIdOfPage(session.imagePage)).toBe(before.image);

      // And the page says which of the two ways in it took, rather than
      // leaving an operator to infer it -- `session.ts`'s `joinedBy`.
      for (const [label, page] of [
        ["app", session.appPage],
        ["image-peer", session.imagePage],
      ] as const) {
        expect(await page.textContent("#session-status"), `${label}: resume message`).toMatch(
          /resumed/i,
        );
      }

      // The invitation in the URL is still there and was still not needed.
      expect(session.appPage.url()).toContain("invite=");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "the provider page applied the pacing its URL asked for",
    async () => {
      // A knob that silently did nothing would make every number in the
      // streaming test a measurement of the default. `pacing.ts` renders what
      // it parsed; this is the check that the page and this file agree.
      const pacing = await session.imagePage.getAttribute("body", "data-pacing");
      expect(JSON.parse(pacing!)).toEqual({
        chunkSize: PROVIDER_CHUNK_SIZE,
        delayMs: PROVIDER_CHUNK_DELAY_MS,
      });
      expect(await session.imagePage.textContent("#serving")).toBe("yes");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "the app page discovers both providers through the hub",
    async () => {
      const found = await waitForState(`${name}: both providers on the view`, 30_000, async () => {
        const [search, images] = await Promise.all([
          session.appPage.getAttribute("#search-provider", "data-status"),
          session.appPage.getAttribute("#images-provider", "data-status"),
        ]);
        return search === "present" && images === "present";
      });
      console.log(`[${name}] both providers discovered in ${found.toFixed(0)}ms`);

      // AND THEY ARE THE RIGHT PEERS — resolved by `kind`, never configured.
      // The image provider's id is a fresh browser identity created seconds
      // ago; the only route by which this page could know it is the hub's
      // bulletin board.
      expect(await renderedProviderPeerId(session.appPage, "search")).toBe(session.stack.hubPeerId);
      expect(await renderedProviderPeerId(session.appPage, "images")).toBe(
        await peerIdOfPage(session.imagePage),
      );

      // Acceptance criterion 4, in its browser form: neither provider's id
      // reached this page by any route other than the mesh view. Checked over
      // the BUILT bundle and the actual URL the browser was pointed at — the
      // two channels by which a page could have been told an id — rather than
      // over the source, which is where a `define` or an env injection would
      // not show up.
      const bundle = distAppSources();
      const imagePeerId = await peerIdOfPage(session.imagePage);
      expect(session.appPage.url()).not.toContain(imagePeerId);
      expect(session.appPage.url()).not.toContain(session.stack.hubPeerId);
      expect(bundle).not.toContain(imagePeerId);
      expect(bundle).not.toContain(session.stack.hubPeerId);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "a search from the page returns rendered results",
    async () => {
      // THE SINGLE RISKIEST UNTESTED LINE IN TASK 13, exercised through the
      // page's own form: `fetch(`${baseUrl}${peerId}/search?q=…`)`. A 200 with
      // rendered results covers the ServiceWorker prefix strip, the runtime's
      // token attachment and the peer-prefix routing in one assertion.
      await session.appPage.fill("#q", SEARCH_QUERY);
      await session.appPage.click("#search-form button[type=submit]");

      await waitForState(`${name}: the search rendered`, 30_000, async () => {
        const tone = await session.appPage.getAttribute("#search-status", "data-tone");
        return tone === "ok" && (await session.appPage.locator("#search-results li").count()) > 0;
      });

      const status = await session.appPage.textContent("#search-status");
      expect(status).toContain("result(s) from");
      expect(status).toContain(session.stack.hubPeerId);
      const titles = await session.appPage.locator("#search-results .title").allTextContents();
      expect(titles.length).toBeGreaterThan(0);
      expect(titles.join("\n")).toContain("relay");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "an image served BY ANOTHER BROWSER TAB renders in the app page",
    async () => {
      // The thing nothing in this record had done. The `<img src>` path is the
      // point, not a shortcut: these URLs go through the same ServiceWorker
      // edge as every `fetch` on the page, so the browser's own image loader —
      // code that has never heard of libp2p — decodes bytes that came out of
      // another tab over WebRTC. `naturalWidth > 0` is the assertion that the
      // decoder actually got a valid image, which a 200 alone would not prove.
      await session.appPage.click("#load-images");

      await waitForState(`${name}: the gallery rendered`, 60_000, async () => {
        const tone = await session.appPage.getAttribute("#images-status", "data-tone");
        // "ok" covers two distinct moments -- `setStatus(imagesStatusEl,
        // "ok", "loading the catalogue…")` right after the click, AND the
        // final success text -- so it is still a legitimate "not yet"
        // here. Every OTHER tone `main.ts` ever sets on `#images-status` is
        // terminal in the same sense: `outcome.ts`'s `CallOutcome.status`
        // can land on "denied"/"unreachable"/"failed", and `loadImages`'s
        // own pre-call branch (`imagesState.status !== "present"`) sets
        // "neutral" for "waiting for the first mesh view" / "nobody is
        // advertising this" and "unreachable" for "departed" -- and in
        // EITHER case `loadImages` returns without making a call, so
        // nothing here re-triggers it. In this test's natural run order the
        // preceding test has already asserted `present`, so "neutral" is
        // unreachable from here in the full-file run -- but it IS reachable
        // running this test alone (`vitest -t "gallery rendered"`), which is
        // exactly what someone chasing a failure does, so leaving it out
        // would silently reintroduce the 60s-timeout mistake for the one
        // person most likely to hit it. Listing every non-"ok" tone here
        // (rather than an allow-list of just "ok") is deliberate: a tone
        // this file has not been taught about should fail loudly, not poll
        // silently for the full budget.
        //
        // ONE BOUNDED FALSE-EXIT WINDOW, ACCEPTED: `renderProviders` can
        // flip this to "unreachable" on a `present -> departed` transition
        // that lands WHILE the images call above is still in flight and
        // then itself succeeds (the call reads `imagesState` from before
        // the transition, so it isn't cancelled by it). This throws on that
        // transient tone even though the in-flight call would have
        // resolved "ok". It needs a real presence lapse (the hub's TTL,
        // ~8s) landing inside the ~100ms poll window this call was made in,
        // and the un-fixed version would have masked the same lapse with a
        // false PASS instead, which is worse -- so this is left as a known,
        // narrow trade rather than something to fix.
        if (
          tone === "denied" ||
          tone === "unreachable" ||
          tone === "failed" ||
          tone === "neutral"
        ) {
          const text = await session.appPage.textContent("#images-status");
          throw new Error(
            `${name}: #images-status reported "${tone}" instead of loading: ${text}\n` +
              `Page errors and warnings, newest last:\n` +
              `${session.faults.join("\n") || "(none captured)"}`,
          );
        }
        if (tone !== "ok") return false;
        // The catalogue arriving is not the image arriving. `<img>` loading is
        // the browser's own asynchronous job, started when `renderGallery` set
        // `src` and finished (or failed) some time later — waiting only for
        // the figures to exist would read `naturalWidth` off elements that
        // have not been decoded yet, which is a race that reports as a bug in
        // the mesh.
        return session.appPage.evaluate(() => {
          const images = [...document.querySelectorAll<HTMLImageElement>("#gallery img")];
          return images.length > 0 && images.every((img) => img.complete);
        });
      });

      const gallery = await session.appPage.evaluate(() =>
        [...document.querySelectorAll("#gallery figure")].map((figure) => {
          const img = figure.querySelector("img")!;
          return {
            naturalWidth: img.naturalWidth,
            naturalHeight: img.naturalHeight,
            failed: (figure as HTMLElement).dataset.failed ?? null,
            src: img.getAttribute("src") ?? "",
          };
        }),
      );

      expect(gallery.length).toBe(4);
      const imagePeerId = await peerIdOfPage(session.imagePage);
      for (const image of gallery) {
        expect(image.failed).toBeNull();
        expect(image.naturalWidth).toBeGreaterThan(0);
        expect(image.naturalHeight).toBeGreaterThan(0);
        // Composed from `baseUrl` + the DISCOVERED peer id, per
        // `pages/app/main.ts`'s `renderGallery`.
        expect(image.src).toContain(`/app/${imagePeerId}/images/`);
      }

      expect(await session.appPage.textContent("#images-status")).toContain(
        `image(s) served by ${imagePeerId}`,
      );
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "the image streams from one browser to the other in more than one chunk",
    async () => {
      const imagePeerId = await peerIdOfPage(session.imagePage);
      const streamed = await fetchStreamed(
        session.appPage,
        imagePeerId,
        `/images/${STREAMED_IMAGE_ID}`,
      );
      console.log(
        `[${name}] streamed ${streamed.sizes.length} chunks ${JSON.stringify(streamed.sizes)} ` +
          `at ${streamed.arrivedAt.map((at) => at.toFixed(0)).join(", ")} ms`,
      );

      const expected = new Uint8Array(
        readFileSync(join(appRoot, `src/services/image-fixtures/${STREAMED_IMAGE_ID}.png`)),
      );
      assertStreamed(streamed, expected);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "a denial renders the policy's own reason into the DOM",
    async () => {
      // The app page holds `member`, and `/admin/` requires `std:mesh.admin`
      // (`src/policy.ts`). Clicking its own revoke button is refused by the
      // hub's access tree, and the tree's `reason` — naming the capability
      // that was missing — is rendered verbatim. A real 403 from real policy,
      // reaching a real DOM node.
      const selfRow = session.appPage.locator("#members li", {
        hasText: await peerIdOfPage(session.appPage),
      });
      await selfRow.locator("button").click();

      await waitForState(`${name}: the denial rendered`, 30_000, async () => {
        return (await session.appPage.getAttribute("#admin-status", "data-tone")) === "denied";
      });

      const denial = await session.appPage.textContent("#admin-status");
      expect(denial).toContain("refused (403)");
      // `rules.ts`'s own wording for a capability the caller lacks —
      // rendered unaltered by `outcome.ts`, which is what makes a denial
      // explicable to someone who did not write the policy.
      expect(denial).toContain("std:mesh.admin");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "closing the image peer's page removes it from the app's view within one TTL",
    async () => {
      // DEPENDS ON: the gallery test, which needs the provider alive. This is
      // a one-way transition — the page never comes back.
      //
      // "No page, no service" (design record §5.5), observed rather than
      // asserted from the outside: the tab closes, the heartbeats stop, the
      // hub's sweep notices, and the app page — which polls the view and
      // remembers what it last saw — says so on its own.
      await session.imagePage.close();

      const budget = PRESENCE_TTL_MS + SWEEP_INTERVAL_MS + 5_000;
      const elapsed = await waitForState(`${name}: the provider departs`, budget, async () => {
        return (
          (await session.appPage.getAttribute("#images-provider", "data-status")) === "departed"
        );
      });
      console.log(`[${name}] provider departed the app's view ${elapsed.toFixed(0)}ms after close`);

      expect(await session.appPage.textContent("#images-provider")).toContain("gone from the mesh");
      // Step 5's "say so at the moment it happens" — the page states it
      // without making a doomed call to find out.
      const status = await session.appPage.textContent("#images-status");
      expect(status).toContain("left the mesh");
      expect(await session.appPage.getAttribute("#images-status", "data-tone")).toBe("unreachable");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "a revoked member's next search is refused, and the page renders why",
    async () => {
      // DEPENDS ON: the search test (this repeats that exact call). One-way:
      // nothing this page does afterwards is accepted.
      //
      // The revocation is driven by a NODE ADMIN, not by the page — the page
      // holds `member` and the previous test proved it cannot revoke anyone.
      // This is the browser half of what leg 1 proved in process.
      session.admin = await session.stack.join({ roles: ["admin"], policies: SERVES_NOTHING });
      const appPeerId = await peerIdOfPage(session.appPage);
      const res = await session.admin.call(session.stack.hubPeerId, `/admin/members/${appPeerId}`, {
        method: "DELETE",
        token: session.admin.token,
      });
      expect(res.status).toBe(200);

      await session.appPage.fill("#q", SEARCH_QUERY);
      await session.appPage.click("#search-form button[type=submit]");

      await waitForState(`${name}: the revoked search is refused`, 30_000, async () => {
        return (await session.appPage.getAttribute("#search-status", "data-tone")) === "denied";
      });

      const status = await session.appPage.textContent("#search-status");
      console.log(`[${name}] revoked search rendered: ${status}`);
      expect(status).toContain("refused (403)");
      expect(await session.appPage.locator("#search-results li").count()).toBe(0);
    },
    TEST_TIMEOUT_MS,
  );
});
