// Python execution over HTTP against a running runtime (scripts/run-env.mjs runs it):
//   BASE_URL=http://127.0.0.1:8788 node --test tests/python.test.mjs
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { pythonCases } from "./python-scenario.mjs";

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

describe(`python (${runtime.python})`, () => {
  if (runtime.python === "none" || runtime.python === "off") {
    test("python tasks answer ENOSYS here", async () => {
      const ws = `py-none-${Date.now()}`;
      const s = (
        await api(`/api/w/${ws}/sessions`, { user: "a", rights: ["/proj"] }, { admin: true })
      ).value;
      const r = await api(`/api/agents/py/run`, {
        workspace: ws,
        token: s.token,
        transport: "token",
        task: { kind: "python", code: "1" },
      });
      assert.equal(r.code, "ENOSYS", r.error);
    });
    return;
  }
  for (const c of pythonCases({ api, label: "node-" })) test(c.name, c.fn);
});
