/**
 * 16 — Which ghost containment actually contains, and what does it cost?
 *
 * Rung 06 found the hole and deliberately refused to choose a remedy, leaving
 * the decision open in the design (§11.1). A decision taken from three
 * plausible descriptions is a guess; this rung turns it into a measurement by
 * running the SAME escape under each candidate, in a real Chromium, with
 * everything but the containment held constant.
 *
 * Three modes, one query parameter apart:
 *
 *   none     — rung 06's result, re-measured here as the control. If the
 *              escape ever stops reproducing, every claim below is vacuous.
 *   csp      — a path-scoped Content-Security-Policy on the ghost's responses.
 *   sandbox  — a sandboxed iframe with no `allow-same-origin`, so the document
 *              has an opaque origin and the viewer's origin is cross-origin.
 *
 * Containment is not the only thing measured. A remedy that also breaks the
 * host app's legitimate relative fetch has not contained anything, it has
 * broken the feature — so every mode is checked on BOTH.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Browser, chromium } from "playwright";
import { build } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Containment, policyFor } from "../src/contain.js";

const here = dirname(fileURLToPath(import.meta.url));

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

interface Rendered {
  mode: Containment;
  /** The host app's relative fetch — must keep working. */
  relative: string;
  /** The root-absolute escape — must NOT read the viewer's origin. */
  rootAbsolute: string;
  /** An attempt to address another peer — refused in every mode. */
  otherPeer: string;
  /** Which paths the host app was actually asked for. */
  hostSaw: string[];
  /** The same url fetched from the CONTROLLED parent document. */
  parentFetch: number | string | undefined;
  /** True when the framed document never ran at all. */
  frameNeverRan: boolean;
  /** Browser console, kept for the modes where the failure IS the finding. */
  logs: string[];
}

describe("16 — ghost containment, measured", () => {
  let dir: string;
  let server: Server;
  let origin: string;
  let browser: Browser;
  const results = new Map<Containment, Rendered>();

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "httpeers-ghost-contain-"));
    await build({
      root: join(here, "../src"),
      logLevel: "warn",
      build: {
        target: "esnext",
        outDir: dir,
        emptyOutDir: true,
        // rolldownOptions + treeshake:false — rung 02's trap.
        rolldownOptions: {
          input: {
            index: join(here, "../src/index.html"),
            sw: join(here, "../src/sw.ts"),
          },
          output: {
            entryFileNames: (chunk: { name: string }) =>
              chunk.name === "sw" ? "sw.js" : "assets/[name]-[hash].js",
          },
          treeshake: false,
        },
      },
    });

    server = createServer((req, res) => {
      const path = (req.url ?? "/").split("?")[0] ?? "/";
      // The viewer's OWN origin serves this. Reaching it IS the escape.
      if (path === "/static/escape.txt") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("VIEWER-ORIGIN-FILE");
        return;
      }
      const file = join(dir, path === "/" ? "index.html" : path);
      // READ FIRST, then write headers. The other order sends a 200 and only
      // then discovers the file is missing, so the 404 throws
      // ERR_HTTP_HEADERS_SENT and the real failure is buried under it.
      let body: Buffer;
      try {
        body = readFileSync(file);
      } catch {
        res.writeHead(404).end("not found");
        return;
      }
      res.writeHead(200, {
        "content-type": TYPES[extname(file)] ?? "application/octet-stream",
        "cache-control": "no-store",
        "service-worker-allowed": "/",
      });
      res.end(body);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const address = server.address();
    if (address == null || typeof address === "string") throw new Error("no address");
    origin = `http://localhost:${address.port}`;
    browser = await chromium.launch();

    for (const mode of ["none", "csp", "sandbox"] as Containment[]) {
      results.set(mode, await render(mode));
    }

    for (const [mode, r] of results) {
      console.log(
        `\n[${mode}]\n  parent fetch : ${String(r.parentFetch)}\n  frame ran    : ${!r.frameNeverRan}\n  relative     : ${r.relative}\n  rootAbsolute : ${r.rootAbsolute}\n  otherPeer    : ${r.otherPeer}\n  host saw     : ${r.hostSaw.join(", ") || "(nothing)"}`,
      );
    }
  }, 300_000);

  afterAll(async () => {
    await browser?.close();
    await new Promise<void>((r) => server?.close(() => r()));
    if (dir != null) rmSync(dir, { recursive: true, force: true });
  });

  async function render(mode: Containment): Promise<Rendered> {
    // A fresh context per mode: a ServiceWorker registration and its caches
    // outlive a page, and a mode that inherited the previous one's worker
    // would be measuring the wrong thing.
    const context = await browser.newContext();
    const page = await context.newPage();
    const logs: string[] = [];
    page.on("console", (m) => logs.push(`[console] ${m.text()}`));
    page.on("pageerror", (e) => logs.push(`[pageerror] ${String(e)}`));
    await page.goto(`${origin}/?mode=${mode}`);
    // A MODE THAT NEVER REPORTS IS A RESULT, NOT AN ERROR. One candidate turns
    // out to prevent the framed document from running at all, and throwing
    // here would have hidden the most important finding in the rung behind a
    // timeout. So the wait is bounded and its failure recorded.
    let frameNeverRan = false;
    try {
      await page.waitForFunction(
        () => {
          const state = window.__contain;
          return state?.error != null || Object.keys(state?.messages ?? {}).length >= 3;
        },
        undefined,
        { timeout: 20_000 },
      );
    } catch {
      frameNeverRan = true;
    }
    const state = await page.evaluate(() => window.__contain);
    await context.close();
    if (state?.error != null) throw new Error(`[${mode}] ${state.error}\n${logs.join("\n")}`);
    return {
      mode,
      relative: state?.messages.relative ?? "",
      rootAbsolute: state?.messages.rootAbsolute ?? "",
      otherPeer: state?.messages.otherPeer ?? "",
      hostSaw: state?.hostSaw ?? [],
      parentFetch: state?.parentFetch,
      frameNeverRan,
      logs,
    };
  }

  it("CLAIM 1 — CONTROL: with no containment, the escape still reproduces", () => {
    // Without this, every claim below could pass because the escape stopped
    // happening for an unrelated reason.
    expect(results.get("none")?.rootAbsolute).toContain("VIEWER-ORIGIN-FILE");
  });

  it("CLAIM 2 — a path-scoped CSP blocks the escape", () => {
    const got = results.get("csp")?.rootAbsolute ?? "";
    expect(got).not.toContain("VIEWER-ORIGIN-FILE");
    // Blocked, not merely 404'd: a CSP violation rejects the fetch, so the
    // page sees an error rather than a response.
    expect(got.startsWith("ERR")).toBe(true);
  });

  it("CLAIM 3 — the CSP does NOT break the host app's own relative fetch", () => {
    // The remedy has to leave the feature working, or it is not a remedy.
    expect(results.get("csp")?.relative).toBe("asset-from-host");
    expect(results.get("csp")?.hostSaw).toContain("/app/asset.txt");
  });

  it("CLAIM 4 — `'self'` would NOT have worked, and the path is why", () => {
    // The reason this needs saying: `'self'` is the reflex, and it permits
    // exactly the escape being closed — the viewer's origin IS self. What
    // contains is the PATH in the source expression, which CSP matches by
    // prefix.
    const policy = policyFor({ baseUrl: "http://localhost:4173/ghost/", mode: "csp" });
    const directives = new Map(
      policy.split("; ").map((d) => {
        const [name, ...sources] = d.split(" ");
        return [name ?? "", sources];
      }),
    );
    // No FETCH directive may name `'self'`: that is the viewer's origin, and
    // permitting it is the escape. `frame-ancestors` may — it governs who may
    // embed the ghost, which is the opposite direction and wants `'self'`.
    for (const name of ["default-src", "connect-src", "img-src", "style-src", "script-src"]) {
      expect(directives.get(name), name).not.toContain("'self'");
      expect(directives.get(name)?.[0], name).toBe("http://localhost:4173/ghost/");
    }
    expect(directives.get("frame-ancestors")).toEqual(["'self'"]);
  });

  it("CLAIM 5 — a sandboxed opaque origin is NOT SW-controlled, so the ghost cannot serve it", () => {
    // THE FINDING OF THE RUNG, and it disqualifies a candidate rather than
    // ranking it. `sandbox` without `allow-same-origin` gives the document an
    // opaque origin — which is exactly what would contain it, and is also
    // exactly what removes it from the ServiceWorker's control. A client is
    // controlled only when its origin matches the registration's; an opaque
    // origin matches nothing. So the frame's request for the ghost's own URL
    // goes to the NETWORK, where nothing serves it.
    const sandbox = results.get("sandbox");
    const csp = results.get("csp");

    // Two points, and the difference between them is the frame's origin and
    // nothing else: the controlled parent fetches the SAME url successfully...
    expect(csp?.parentFetch).toBe(200);
    expect(sandbox?.parentFetch).toBe(200);
    // ...while the sandboxed frame never runs at all.
    expect(csp?.frameNeverRan).toBe(false);
    expect(sandbox?.frameNeverRan).toBe(true);
    // The ghost was asked for exactly one thing: the parent's own probe. The
    // frame contributed nothing, because its request never reached the worker.
    expect(sandbox?.hostSaw).toEqual(["/app/"]);
    expect(csp?.hostSaw).toContain("/app/asset.txt");
  });

  it("CLAIM 6 — so containment by opaque origin costs the ghost its transport", () => {
    // Stated separately because it is the part that decides the design: the
    // sandbox does contain — nothing escapes, because nothing runs — but it
    // contains by breaking the feature. CORS on the ghost's responses does not
    // rescue it: the problem is not that the request is refused, it is that
    // the ServiceWorker never sees the request to answer.
    const sandbox = results.get("sandbox");
    expect(sandbox?.rootAbsolute).not.toContain("VIEWER-ORIGIN-FILE");
    expect(sandbox?.relative).not.toBe("asset-from-host");
  });

  it("CLAIM 7 — the pin holds in every mode: no other peer is reachable", () => {
    // Containment is additive. It must not be able to weaken what rung 06
    // established, in any mode.
    for (const mode of ["none", "csp", "sandbox"] as Containment[]) {
      const got = results.get(mode)?.otherPeer ?? "";
      expect(got, `mode ${mode}`).not.toBe("200");
    }
  });
});

declare global {
  interface Window {
    __contain?: {
      mode: Containment;
      ready: boolean;
      baseUrl: string;
      messages: Record<string, string>;
      hostSaw: string[];
      parentFetch?: number | string;
      error?: string;
    };
  }
}
