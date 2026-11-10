// The `agent` task over HTTP against a running runtime (scripts/run-env.mjs runs it, with the
// fake model as the LLM var).
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { agentCases } from "./agent-scenario.mjs";

const BASE = process.env.BASE_URL ?? "http://127.0.0.1:8788";
const ADMIN = process.env.ADMIN_KEY ?? "dev-admin-key";
const TRANSPORTS = (process.env.TRANSPORTS ?? "stub,token").split(",").filter(Boolean);

async function api(path, body, { admin = false, headers: extra = {} } = {}) {
  const headers = { "content-type": "application/json", ...extra };
  if (admin) headers.authorization = `Bearer ${ADMIN}`;
  const res = await fetch(`${BASE}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, ...(await res.json()) };
}

const runtime = (await api("/api/runtime")).value;

describe(`agent (model: ${runtime.llm ? runtime.llm.model : "none"})`, () => {
  if (!runtime.llm || runtime.llm.error) {
    test("without a model the agent task answers ENOSYS", async () => {
      const ws = `ag-none-${Date.now()}`;
      const s = (
        await api(`/api/w/${ws}/sessions`, { user: "a", rights: ["/proj"] }, { admin: true })
      ).value;
      const r = await api(`/api/agents/a/run`, {
        workspace: ws,
        token: s.token,
        transport: "token",
        task: { kind: "agent", prompt: "x" },
      });
      assert.equal(r.code, runtime.llm?.error ? "EINVAL" : "ENOSYS", r.error);
    });
    return;
  }
  test("the runtime reports the model, never the key", () => {
    assert.equal(runtime.llm.model, "fake-model");
    assert.doesNotMatch(JSON.stringify(runtime), /sk-fake/);
  });
  for (const c of agentCases({ api, transports: TRANSPORTS, label: "node-" })) test(c.name, c.fn);
});
