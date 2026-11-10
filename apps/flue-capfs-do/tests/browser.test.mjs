// The project in a browser on cellb (Chromium, Playwright): the cells run in a Dedicated Worker
// with SQLite on OPFS, the page reaches them over a MessagePort, Python runs in its own Worker.
// Runs the Python cases and the core capability checks through the page.
//   node --test tests/browser.test.mjs        (builds dist/ first)
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { chromium } from "playwright";
import { buildBrowser } from "../scripts/build-browser.mjs";
import { startServer } from "../scripts/serve-browser.mjs";
import { agentCases } from "./agent-scenario.mjs";
import { startFakeLlm } from "./helpers/fake-llm.mjs";
import { pythonCases } from "./python-scenario.mjs";

let server;
let fakeLlm;
let browser;
let page;
const errors = [];

before(async () => {
  fakeLlm = await startFakeLlm();
  await buildBrowser({
    quiet: true,
    vars: { LLM: JSON.stringify(fakeLlm.config), LLM_API_KEY: "sk-fake" },
  });
  server = await startServer(0);
  const { port } = server.address();
  browser = await chromium
    .launch()
    .catch(() =>
      chromium.launch({ executablePath: process.env.PW_CHROMIUM ?? "/opt/pw-browsers/chromium" }),
    );
  page = await browser.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${port}/?data=test-${Date.now().toString(36)}`);
  await page.evaluate(() => window.capfs.ready);
});
after(async () => {
  await browser?.close();
  server?.close();
  fakeLlm?.server.close();
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

  test("no uncaught errors in the page", () => {
    assert.deepEqual(errors, []);
  });
});
