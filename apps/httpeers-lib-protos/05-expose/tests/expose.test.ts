/**
 * 05 — Are "reverse proxy" and "expose a local service" one mechanism?
 *
 * Eleven scenarios, written once in `../src/scenarios.ts`, run twice: in Node
 * directly, and in Chromium with the same module bundled into a page served
 * from the upstream's own origin. Same route table, same upstreams, same
 * assertions — so a platform difference shows up as a row that passes in one
 * column and fails in the other.
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { build } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Fixture, startFixture } from "../src/fixture-server.js";
import { type Outcome, runScenarios } from "../src/scenarios.js";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * The one row a browser cannot pass, named rather than tolerated.
 *
 * `Via` is a forbidden header name under the Fetch spec: a page may not set
 * it, and the browser drops it with no error. ADR-0015 has an intermediary
 * announce itself with `Via`, so that part of the ADR is unimplementable in a
 * browser-hosted intermediary — a fact about the platform, not about this code.
 */
const BROWSER_CANNOT = ["url upstream: Via is set (browsers forbid it)"];

describe("05 — one route table, two upstream kinds", () => {
  let fixture: Fixture;
  let node: Outcome[];
  let browser: Outcome[];

  beforeAll(async () => {
    fixture = await startFixture();
    node = await runScenarios(fixture.origin);
    browser = await runInChromium(fixture.origin);

    const rows = node.map((n) => {
      const b = browser.find((x) => x.name === n.name);
      return `  node ${n.pass ? "✓" : "✗"}  browser ${b?.pass ? "✓" : "✗"}  ${n.name}`;
    });
    console.log(`\nScenario results:\n${rows.join("\n")}\n`);
  }, 300_000);

  afterAll(async () => {
    await fixture?.close();
  });

  it("CLAIM 1 — every scenario passes under Node", () => {
    const failed = node.filter((o) => !o.pass);
    expect(failed.map((f) => `${f.name}: ${f.detail}`)).toEqual([]);
  });

  it("CLAIM 2 — every scenario passes in a browser, except the one the platform forbids", () => {
    const failed = browser.filter((o) => !o.pass).map((f) => f.name);
    expect(failed).toEqual(BROWSER_CANNOT);
  });

  it("CLAIM 3 — the two platforms agree scenario for scenario, apart from that one", () => {
    expect(browser.map((b) => b.name)).toEqual(node.map((n) => n.name));
    const disagreements = node
      .filter((n) => browser.find((b) => b.name === n.name)?.pass !== n.pass)
      .map((n) => n.name);
    expect(disagreements).toEqual(BROWSER_CANNOT);
  });
});

/** Bundle the scenarios and run them inside a page on the upstream's origin. */
async function runInChromium(origin: string): Promise<Outcome[]> {
  const built = await build({
    root: here,
    logLevel: "error",
    build: {
      target: "esnext",
      write: false,
      lib: {
        entry: resolve(here, "../src/browser-entry.ts"),
        formats: ["iife"],
        name: "ExposeProbe",
      },
    },
  });
  // biome-ignore lint/suspicious/noExplicitAny: vite's build() union is not narrowable here.
  const results = (Array.isArray(built) ? built : [built]) as any[];
  const chunk = results[0]?.output?.find((o: { type: string }) => o.type === "chunk");
  if (chunk == null) throw new Error("no chunk built for the browser run");

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.goto(`${origin}/page`);
    await page.addScriptTag({ content: chunk.code });
    const outcomes = await page.evaluate(async (o) => {
      return await (
        window as unknown as { ExposeProbe: { run(origin: string): Promise<Outcome[]> } }
      ).ExposeProbe.run(o);
    }, origin);
    if (errors.length > 0) throw new Error(`page errors: ${errors.join("; ")}`);
    return outcomes;
  } finally {
    await browser.close();
  }
}
