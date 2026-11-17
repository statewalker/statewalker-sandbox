// PROTOTYPE (statewalker/statewalker-root#89): user sessions and agent sessions on cellb.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { fakeModel, startProject } from "./servers.mjs";

let model, p;
before(async () => {
  model = await fakeModel();
  p = await startProject({ LLM_BASE_URL: model.url });
  await p.admin("/admin/seed", {
    files: {
      "/alpha/readme.md": "# alpha\n",
      "/beta/notes.md": "beta\n",
      "/alpha/.system/secret": "s3cret\n",
    },
  });
});
after(async () => {
  await p?.close();
  model?.close();
});

const login = async (user, ttlMs) =>
  (await p.call("POST", "/v1/login", { user, ttlMs })).body.token;
const as = (token) => ({
  me: () => p.call("GET", "/v1/me", undefined, { authorization: `Bearer ${token}` }),
  mode: (mode) => p.call("PUT", "/v1/me/mode", { mode }, { authorization: `Bearer ${token}` }),
  revoke: () => p.call("POST", "/v1/me/revoke", {}, { authorization: `Bearer ${token}` }),
  start: (project, agent, parent) =>
    p.call(
      "POST",
      "/v1/sessions",
      { project, agent, parent },
      { authorization: `Bearer ${token}` },
    ),
  say: (id, content) =>
    p.call(
      "POST",
      `/v1/sessions/${id}/messages`,
      { content },
      { authorization: `Bearer ${token}` },
    ),
  archive: (id) =>
    p.call("POST", `/v1/sessions/${id}/archive`, {}, { authorization: `Bearer ${token}` }),
  answer: (id, decision, message) =>
    p.call(
      "POST",
      `/v1/approvals/${id}`,
      { decision, message },
      { authorization: `Bearer ${token}` },
    ),
});
const role = (user, project, r) => p.admin("/admin/role", { project, user, role: r });
const file = async (path) =>
  (
    await p.call("GET", `/admin/file?path=${encodeURIComponent(path)}`, undefined, {
      authorization: "Bearer dev-admin-key",
    })
  ).body;
let n = 0;
/** A fresh user per test: one user session each. */
const fresh = async (r = "editor", project = "alpha") => {
  const user = `u${++n}`;
  await role(user, project, r);
  return { user, api: as(await login(user)) };
};

describe("user session", () => {
  test("an access token opens the user session; a second token resumes the same one", async () => {
    const { user, api } = await fresh();
    const a = (await api.me()).body;
    assert.equal(a.user, user);
    assert.equal(a.mode, "default");
    const again = (await as(await login(user)).me()).body;
    assert.equal(again.id, a.id);
  });

  test("tools are what the agent asks for, cut to the role; the model is offered only those", async () => {
    const { api } = await fresh("editor");
    const s = (await api.start("alpha", "coder")).body;
    assert.deepEqual(s.tools, ["read", "grep", "glob", "edit", "write"]);
    assert.deepEqual(s.dropped, ["bash"]);
    assert.equal(s.capability, undefined, "the capability never leaves the server");
    const r = (await api.say(s.id, "hello")).body;
    assert.deepEqual([...model.requests.at(-1).tools].sort(), [...s.tools].sort());
    assert.equal(r.text, "OK");
  });

  test("a project the user isn't a member of can't be started, and isn't in the file view", async () => {
    const { api } = await fresh("editor");
    assert.equal((await api.start("beta", "coder")).status, 403);
    const s = (await api.start("alpha", "coder")).body;
    const ls = (await api.say(s.id, 'CALL glob {"pattern":"*","path":"/"}')).body;
    assert.ok(!ls.calls[0].result.includes("beta"), ls.calls[0].result);
  });

  test("the system folder is never visible to an agent", async () => {
    const { api } = await fresh("owner");
    await api.mode("bypassPermissions");
    const s = (await api.start("alpha", "coder")).body;
    const r = (await api.say(s.id, "READ /alpha/.system/secret")).body;
    assert.ok(r.calls[0].isError);
    assert.match(r.calls[0].result, /ENOENT|not found|No such/i);
  });
});

describe("modes and approvals", () => {
  test("default mode: a write asks, the turn stops, approving runs the stored write", async () => {
    const { api } = await fresh("editor");
    const s = (await api.start("alpha", "writer")).body;
    const r = (await api.say(s.id, "WRITE /alpha/a.md first")).body;
    assert.match(r.approval, /^ap-/);
    assert.equal(r.text, "", "the turn ended at the approval");
    assert.equal(await file("/alpha/a.md"), null);
    assert.equal(
      (await api.me()).body.approvals[0].id,
      r.approval,
      "pending approvals are on the user session",
    );
    assert.equal((await api.answer(r.approval, "allow")).body.state, "done");
    assert.equal(await file("/alpha/a.md"), "first");
  });

  test("a mode switch reaches a running agent session; approving after it re-checks and refuses", async () => {
    const { api } = await fresh("editor");
    const s = (await api.start("alpha", "writer")).body;
    const r = (await api.say(s.id, "WRITE /alpha/b.md later")).body;
    await api.mode("plan");
    const a = (await api.answer(r.approval, "allow")).body;
    assert.equal(a.state, "refused");
    assert.match(a.reason, /mode plan denies write/);
    await api.mode("acceptEdits");
    const w = (await api.say(s.id, "WRITE /alpha/b.md now")).body;
    assert.equal(w.approval, undefined);
    assert.equal(await file("/alpha/b.md"), "now");
  });

  test("deny with a reason", async () => {
    const { api } = await fresh("editor");
    const s = (await api.start("alpha", "writer")).body;
    const r = (await api.say(s.id, "WRITE /alpha/c.md x")).body;
    assert.equal((await api.answer(r.approval, "deny", "not now")).body.state, "denied");
    assert.equal(await file("/alpha/c.md"), null);
  });

  test("only the user session holds the mode: a sub-agent's own mode only adds strictness", async () => {
    const { api } = await fresh("editor");
    await api.mode("bypassPermissions");
    const reviewer = (await api.start("alpha", "reviewer")).body;
    assert.equal(reviewer.mode, "plan");
    const sub = (await api.start("alpha", "writer", reviewer.id)).body;
    assert.deepEqual(sub.tools, ["read"], "a sub-agent's ceiling is its parent's tools");
    assert.deepEqual(sub.dropped, ["write"]);
  });
});

describe("live roles", () => {
  test("a demotion reaches a running session at its next action; its tool set isn't rebuilt", async () => {
    const { user, api } = await fresh("editor");
    await api.mode("acceptEdits");
    const s = (await api.start("alpha", "writer")).body;
    assert.equal((await api.say(s.id, "WRITE /alpha/d.md one")).body.calls[0].isError, false);
    await role(user, "alpha", "reader");
    const r = (await api.say(s.id, "WRITE /alpha/d.md two")).body;
    assert.deepEqual(r.offered, ["read", "write"], "still listed");
    assert.ok(r.calls[0].isError);
    assert.match(r.calls[0].result, /reader role may not write/);
    await role(user, "alpha", null);
    const gone = (await api.say(s.id, "READ /alpha/readme.md")).body;
    assert.match(gone.calls[0].result, /no longer a member/);
  });
});

describe("tokens and revocation", () => {
  test("an agent keeps working after the access token expires; a new token resumes the user session", async () => {
    const user = `u${++n}`;
    await role(user, "alpha", "editor");
    const short = as(await login(user, 1500));
    await short.mode("acceptEdits");
    const s = (await short.start("alpha", "writer")).body;
    const turn = short.say(s.id, "SLOW 2500 WRITE /alpha/late.md written after expiry");
    await new Promise((r) => setTimeout(r, 1700));
    assert.equal((await short.me()).status, 401, "the token has expired");
    assert.equal((await turn).body.calls[0].isError, false);
    assert.equal(await file("/alpha/late.md"), "written after expiry");
    const before = (await as(await login(user)).me()).body;
    assert.equal(before.sessions.length, 1, "the same user session, with its agent session");
  });

  test("revoking a session stops it and its sub-agents; a sibling keeps running", async () => {
    const { api } = await fresh("editor");
    await api.mode("acceptEdits");
    const coder = (await api.start("alpha", "coder")).body;
    const sibling = (await api.start("alpha", "writer")).body;
    const sub = (await api.start("alpha", "reviewer", coder.id)).body;
    assert.deepEqual((await api.archive(coder.id)).body.revoked.sort(), [coder.id, sub.id].sort());
    const subRead = (await api.say(sub.id, "READ /alpha/readme.md")).body;
    assert.match(subRead.calls[0].result, /revoked/);
    assert.equal((await api.say(sibling.id, "READ /alpha/readme.md")).body.calls[0].isError, false);
  });

  test("revoking the user session stops every agent session", async () => {
    const { api } = await fresh("editor");
    const s = (await api.start("alpha", "writer")).body;
    await api.revoke();
    const r = (await api.say(s.id, "READ /alpha/readme.md")).body;
    assert.match(JSON.stringify(r), /revoked|no such agent session/);
  });
});
