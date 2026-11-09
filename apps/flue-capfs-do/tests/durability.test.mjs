// Run twice around a runtime restart on the same state (scripts/run-env.mjs does this):
//   PHASE=write  creates a workspace, a session in plan mode, a delegated token and a file
//   PHASE=check  after the restart: files, root key, session mode and revocations survived
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { Biscuit } from "@statewalker/webrun-biscuit";

const BASE = process.env.BASE_URL;
const STATE = process.env.DURABILITY_FILE;
const H = {
  "content-type": "application/json",
  authorization: `Bearer ${process.env.ADMIN_KEY ?? "dev-admin-key"}`,
};
const post = async (path, body) =>
  (
    await fetch(`${BASE}${path}`, { method: "POST", headers: H, body: JSON.stringify(body) })
  ).json();
const sh = (ws, token, script, transport = "token") =>
  post("/api/agents/durable/run", {
    workspace: ws,
    token,
    transport,
    task: { kind: "bash", script },
  });

const bootId = async () => (await (await fetch(`${BASE}/api/runtime`)).json()).value.bootId;

test(`durability phase ${process.env.PHASE}`, async () => {
  if (process.env.PHASE === "write") {
    const ws = `durable-${Date.now().toString(36)}`;
    await post(`/api/w/${ws}/seed`, { files: { "/proj/a.md": "before restart\n" } });
    const s = (
      await post(`/api/w/${ws}/sessions`, {
        user: "alice",
        rights: ["/proj", "/plans"],
        mode: "plan",
      })
    ).value;
    const child = Biscuit.fromBase64(s.token)
      .attenuate(`check if operation($o), ["read","list"].contains($o);`)
      .toBase64();
    const rid = (
      await post("/api/agents/durable/run", {
        workspace: ws,
        token: child,
        transport: "token",
        task: { kind: "revocationId" },
      })
    ).value.result;
    await post(`/api/w/${ws}/sessions/${s.session}/revoke`, { rid });
    const w = await sh(ws, s.token, "echo plan > /plans/p.md");
    assert.equal(w.value.result.exitCode, 0);
    writeFileSync(STATE, JSON.stringify({ ws, ...s, child, bootId: await bootId() }));
  } else {
    const { ws, token, child, bootId: before } = JSON.parse(readFileSync(STATE, "utf8"));
    assert.notEqual(await bootId(), before, "this is a new runtime process");
    const r = await sh(ws, token, "cat /proj/a.md /plans/p.md");
    assert.equal(r.value.result.stdout, "before restart\nplan\n", "files and root key survived");
    const w = await sh(ws, token, "echo x > /proj/b.md");
    assert.notEqual(w.value.result.exitCode, 0, "plan mode survived");
    const c = await sh(ws, child, "cat /proj/a.md");
    assert.ok(!c.ok || c.value.result.exitCode !== 0, "revocation survived");
    const stub = await sh(ws, token, "cat /proj/a.md", "stub");
    if (stub.ok) assert.equal(stub.value.result.stdout, "before restart\n");
  }
});
