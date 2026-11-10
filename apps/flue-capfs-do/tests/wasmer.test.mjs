// Wasmer sandboxes over HTTP against a running runtime (scripts/run-env.mjs runs it):
//   BASE_URL=http://127.0.0.1:8788 node --test tests/wasmer.test.mjs
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { wasmerCases } from "./wasmer-scenario.mjs";

const BASE = process.env.BASE_URL ?? "http://127.0.0.1:8788";
const ADMIN = process.env.ADMIN_KEY ?? "dev-admin-key";

async function api(path, body, { admin = false } = {}) {
  const headers = { "content-type": "application/json" };
  if (admin) headers.authorization = `Bearer ${ADMIN}`;
  const res = await fetch(`${BASE}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, ...(await res.json()) };
}

const runtime = (await api("/api/runtime")).value;

describe(`wasmer (${runtime.wasmer})`, () => {
  if (runtime.wasmer !== "node" && runtime.wasmer !== "browser") {
    test("wasmer tasks answer ENOSYS here", async () => {
      const ws = `wm-none-${Date.now()}`;
      const s = (
        await api(`/api/w/${ws}/sessions`, { user: "a", rights: ["/proj"] }, { admin: true })
      ).value;
      const r = await api(`/api/agents/wm/run`, {
        workspace: ws,
        token: s.token,
        transport: "token",
        task: { kind: "wasmer", script: "true" },
      });
      assert.equal(r.code, "ENOSYS", r.error);
    });
    return;
  }
  for (const c of wasmerCases({ api, label: "node-", llm: !!runtime.llm }))
    test(c.name, c.fn, { timeout: 240000 });
});
