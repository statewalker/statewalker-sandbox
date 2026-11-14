// The project in a browser on cellb (Chromium, Playwright): the cells run in a Dedicated Worker
// with SQLite on OPFS, the page reaches them over a MessagePort, Python runs in its own Worker.
// Runs the Python cases and the core capability checks through the page.
//   node --test tests/browser.test.mjs        (builds dist/ first)

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, describe, test } from "node:test";
import { chromium } from "playwright";
import { buildBrowser } from "../scripts/build-browser.mjs";
import { startServer } from "../scripts/serve-browser.mjs";
import { agentCases } from "./agent-scenario.mjs";
import { bundleTodoTool } from "./fixtures/bundle-fixture.mjs";
import { startFakeLlm } from "./helpers/fake-llm.mjs";
import { startWasmServer } from "./helpers/wasm-server.mjs";
import { pythonCases } from "./python-scenario.mjs";
import { wasmerCases } from "./wasmer-scenario.mjs";

const TODO_TOOL = new URL("./fixtures/todo-tool.ts", import.meta.url);
let server;
let fakeLlm;
let wasmServer;
let browser;
let page;
const errors = [];

before(async () => {
  fakeLlm = await startFakeLlm();
  wasmServer = await startWasmServer();
  await buildBrowser({
    quiet: true,
    vars: {
      LLM: JSON.stringify(fakeLlm.config),
      LLM_API_KEY: "sk-fake",
      BUNDLER_WASM_URL: wasmServer.url,
    },
  });
  server = await startServer(0);
  const { port } = server.address();
  // The Wasmer engine fetches packages from the Wasmer registry: through the environment's
  // proxy when there is one (local servers bypass it).
  const proxy = process.env.HTTPS_PROXY
    ? { server: process.env.HTTPS_PROXY, bypass: "127.0.0.1,localhost" }
    : undefined;
  browser = await chromium.launch({ proxy }).catch(() =>
    chromium.launch({
      proxy,
      executablePath: process.env.PW_CHROMIUM ?? "/opt/pw-browsers/chromium",
    }),
  );
  page = await (await browser.newContext({ ignoreHTTPSErrors: !!proxy })).newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${port}/?data=test-${Date.now().toString(36)}`);
  await page.evaluate(() => window.capfs.ready);
});
after(async () => {
  await browser?.close();
  server?.close();
  fakeLlm?.server.close();
  wasmServer?.server.close();
});

const api = (path, body, opts) =>
  page.evaluate(([p, b, o]) => window.capfs.api(p, b, o), [path, body, opts ?? {}]);

describe("browser (cellb in Chromium)", () => {
  test("the cells run in the browser", async () => {
    const r = await api("/api/runtime");
    assert.equal(r.ok, true);
    assert.match(r.value.userAgent, /Chrome/);
    assert.equal(r.value.python, "browser");
  });

  test("the capability holds in the browser: rights, delegation, Flue tools", async () => {
    const ws = `b-${Date.now().toString(36)}`;
    await api(
      `/api/w/${ws}/seed`,
      { files: { "/p1/a.txt": "hello\n", "/p10/s.txt": "secret\n" } },
      { admin: true },
    );
    const { token } = (
      await api(`/api/w/${ws}/sessions`, { user: "alice", rights: ["/p1"] }, { admin: true })
    ).value;
    for (const transport of ["stub", "token"]) {
      const r = await api(`/api/agents/b-${ws}/run`, {
        workspace: ws,
        token,
        transport,
        task: { kind: "bash", script: "ls /; cat /p1/a.txt; cat /p10/s.txt" },
      });
      assert.equal(r.value.result.stdout, "p1\nhello\n");
      const flue = await api(`/api/agents/b-${ws}/run`, {
        workspace: ws,
        token,
        transport,
        chain: [{ readOnly: true }],
        task: {
          kind: "flue",
          calls: [
            { tool: "read", params: { path: "/p1/a.txt" } },
            { tool: "write", params: { path: "/p1/b.txt", content: "x" } },
          ],
        },
      });
      assert.deepEqual(
        flue.value.result.map((c) => c.isError),
        [false, true],
      );
    }
  });

  for (const c of pythonCases({ api, label: "browser-" })) test(`python: ${c.name}`, c.fn);

  for (const c of agentCases({ api, label: "browser-" })) test(`agent: ${c.name}`, c.fn);

  test("the page is cross-origin isolated, so Wasmer runs in the browser", async () => {
    assert.equal(await page.evaluate(() => crossOriginIsolated), true);
    assert.equal((await api("/api/runtime")).value.wasmer, "browser");
  });
  for (const c of wasmerCases({ api, label: "browser-", llm: true }))
    test(`wasmer: ${c.name}`, { timeout: 240000 }, c.fn);

  test("a tool is bundled by the bundler Worker in a browser isolate", async () => {
    const rt = await api("/api/runtime");
    assert.equal(rt.value.bundler, true);
    const ws = `bundle-${Date.now().toString(36)}`;
    await api(`/api/w/${ws}/seed`, { files: { "/proj/a.md": "TODO: x\n" } }, { admin: true });
    const s = await api(`/api/w/${ws}/sessions`, { user: "u", rights: ["/proj"] }, { admin: true });
    const sources = { "/index.ts": readFileSync(TODO_TOOL, "utf8") };
    const r = await api("/api/agents/bundler/run", {
      workspace: ws,
      token: s.value.token,
      transport: "token",
      task: { kind: "bundle", sources, entry: "/index.ts" },
    });
    assert.equal(r.ok, true, r.error);
    assert.equal(r.value.result.check.ok, true);
    assert.equal(r.value.result.hash, (await bundleTodoTool()).hash, "the same bundle as on Node");
  });

  test("no uncaught errors in the page", () => {
    assert.deepEqual(errors, []);
  });
});
