// PROTOTYPE (statewalker/statewalker-root#90): tool definitions on cellb, end to end.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { fakeMcp, fakeModel, fakeWeather, startProject } from "./servers.mjs";

const NS = "x-dev.cellb.harness";
let model, mcp, weather, p;

before(async () => {
  [model, mcp, weather] = await Promise.all([fakeModel(), fakeMcp(), fakeWeather()]);
  p = await startProject({
    LLM_BASE_URL: model.url,
    MCP_GITHUB_URL: mcp.url,
    WEATHER_URL: weather.url,
    WEATHER_API_KEY: "wk-secret",
  });
  await p.admin("/admin/w/acme/seed", {
    files: { "/alpha/readme.md": "# alpha\n", "/hr/salaries.csv": "alice,1\n" },
  });
  await p.admin("/admin/w/acme/members/alpha", { alice: "editor", rita: "reader", olga: "owner" });
});
after(async () => {
  await p?.close();
  for (const s of [model, mcp, weather]) s?.close();
});

const start = async (user, agent, mode = "default") => {
  const r = await p.call("POST", "/v1/sessions", {
    workspace: "acme",
    user,
    project: "alpha",
    agent,
    mode,
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body;
};
const say = async (id, content) =>
  (await p.call("POST", `/v1/sessions/${id}/messages`, { content })).body;
const mcpCall = async (id, method, params) =>
  (await p.call("POST", `/v1/sessions/${id}/mcp`, { jsonrpc: "2.0", id: 1, method, params })).body;
const names = (tools) => tools.offered.map((t) => t.name).sort();

describe("tool definitions: one OpenAPI document per tool, restricted profile", () => {
  test("every source becomes a definition with one POST, a closed object input and a valid name", async () => {
    const defs = (await p.call("GET", "/v1/catalog")).body;
    const ids = defs.map((d) => d[NS].id).sort();
    assert.deepEqual(ids, [
      "github/create_issue",
      "github/search_issues", // from the MCP server's tools/list
      "harness/members.add",
      "harness/members.list", // built in
      "todo/add",
      "todo/list",
      "todo/peek", // native
      "weather/addStations",
      "weather/forecast", // imported from the REST spec
    ]);
    for (const d of defs) {
      assert.equal(d.openapi, "3.1.0");
      const ops = Object.entries(d.paths);
      assert.equal(ops.length, 1);
      assert.deepEqual(Object.keys(ops[0][1]), ["post"]);
      const input = ops[0][1].post.requestBody.content["application/json"].schema;
      assert.equal(input.type, "object");
      assert.equal(input.additionalProperties, false);
      assert.match(d[NS].name, /^[A-Za-z0-9_-]{1,64}$/);
    }
  });

  test("an imported REST operation is flattened, and the route keeps where each argument goes", async () => {
    const defs = (await p.call("GET", "/v1/catalog")).body;
    const f = defs.find((d) => d[NS].id === "weather/forecast");
    const input =
      f.paths["/tools/weather/forecast"].post.requestBody.content["application/json"].schema;
    assert.deepEqual(Object.keys(input.properties).sort(), ["X-Units", "city", "days"]);
    assert.deepEqual(input.required, ["city"]);
    assert.deepEqual(
      f[NS].route.params.map((x) => x.in),
      ["path", "query", "header"],
    );
    const bulk = defs.find((d) => d[NS].id === "weather/addStations");
    const bulkInput =
      bulk.paths["/tools/weather/addStations"].post.requestBody.content["application/json"].schema;
    assert.equal(bulkInput.properties.body.type, "array"); // a non-object body is wrapped
    assert.equal(bulk[NS].route.body, "wrapped");
  });
});

describe("narrowing: role, agent request and mode decide the session's set", () => {
  test("an editor running the coder: requested ∩ granted, and Flue and MCP see the same set", async () => {
    const s = await start("alice", "coder");
    assert.equal(s.role, "editor");
    assert.deepEqual(names(s.tools), [
      "github__create_issue",
      "github__search_issues",
      "harness__members_list",
      "todo__add",
      "todo__list",
      "todo__peek",
    ]);
    const why = Object.fromEntries(s.tools.absent.map((a) => [a.id, a.why]));
    assert.equal(why["harness/members.add"], "not requested by the agent");
    assert.equal(why["weather/forecast"], "not requested by the agent");
    // the model was offered exactly that set
    await say(s.id, "hello");
    assert.deepEqual([...model.requests.at(-1).tools].sort(), names(s.tools));
    // and the session's MCP endpoint lists exactly that set
    const listed = await mcpCall(s.id, "tools/list", {});
    assert.deepEqual(listed.result.tools.map((t) => t.name).sort(), names(s.tools));
    const add = listed.result.tools.find((t) => t.name === "todo__add");
    assert.equal(add.annotations.readOnlyHint, false);
    assert.equal(add.inputSchema.additionalProperties, false);
  });

  test("a reader running the same agent gets less; the agent's request can't widen it", async () => {
    const s = await start("rita", "coder", "bypassPermissions");
    assert.deepEqual(names(s.tools), [
      "github__search_issues",
      "harness__members_list",
      "todo__list",
    ]);
    assert.match(
      s.tools.absent.find((a) => a.id === "todo/add").why,
      /reader role lacks tools.use:todo\/add/,
    );
  });

  test("plan mode doesn't offer write tools at all; asking tools are offered", async () => {
    const s = await start("olga", "admin", "plan");
    assert.ok(
      names(s.tools).every(
        (n) =>
          ![
            "todo__add",
            "github__create_issue",
            "harness__members_add",
            "weather__addStations",
          ].includes(n),
      ),
    );
    const d = (await p.call("PUT", `/v1/sessions/${s.id}/mode`, { mode: "default" })).body;
    assert.equal(d.offered.find((t) => t.name === "harness__members_add").decision, "ask");
    assert.equal(d.offered.find((t) => t.name === "todo__list").decision, "allow");
  });
});

describe("calls go through the harness and the capability", () => {
  test("a forged call to a tool the session wasn't offered is refused, by Flue and by MCP", async () => {
    const s = await start("rita", "coder", "bypassPermissions");
    const r = await say(s.id, 'CALL todo__add {"text":"sneak"}');
    assert.equal(r.calls[0].name, "todo__add");
    assert.ok(r.calls[0].isError);
    assert.match(r.calls[0].result, /not found/); // pi never had it
    const m = await mcpCall(s.id, "tools/call", {
      name: "todo__add",
      arguments: { text: "sneak" },
    });
    assert.equal(m.error.code, -32602);
    assert.match(m.error.message, /not offered.*reader role lacks/);
  });

  test("an asking tool pauses the turn; approving re-checks and runs the stored call", async () => {
    const s = await start("alice", "coder", "default");
    const r = await say(s.id, 'CALL todo__add {"text":"write the spec"}');
    const approval = /approval required: (\S+)/.exec(r.calls[0].result)?.[1];
    assert.ok(approval, r.calls[0].result);
    assert.equal(r.text, "", "the turn stopped at the approval (terminate)");
    const a = (
      await p.call("POST", `/v1/sessions/${s.id}/approvals/${approval}`, { decision: "allow" })
    ).body;
    assert.equal(a.state, "done");
    const list = await say(s.id, "CALL todo__list {}");
    assert.match(list.calls[0].result, /write the spec/);
  });

  test("approving after a switch to plan is refused: the call is re-checked", async () => {
    const s = await start("alice", "coder", "default");
    const r = await say(s.id, 'CALL todo__add {"text":"later"}');
    const approval = /approval required: (\S+)/.exec(r.calls[0].result)[1];
    await p.call("PUT", `/v1/sessions/${s.id}/mode`, { mode: "plan" });
    const a = (
      await p.call("POST", `/v1/sessions/${s.id}/approvals/${approval}`, { decision: "allow" })
    ).body;
    assert.equal(a.state, "refused");
    assert.match(a.result.content[0].text, /not offered.*mode plan denies write/);
  });

  test("a native tool sees only the capability's files", async () => {
    const s = await start("alice", "coder", "acceptEdits");
    const inside = await say(s.id, 'CALL todo__peek {"path":"/alpha/readme.md"}');
    assert.match(inside.calls[0].result, /# alpha/);
    const outside = await say(s.id, 'CALL todo__peek {"path":"/hr/salaries.csv"}');
    assert.ok(outside.calls[0].isError);
    assert.match(outside.calls[0].result, /EACCES|ENOENT|denied/);
  });

  test("an MCP tool is called on the remote server through the harness", async () => {
    const s = await start("alice", "coder", "acceptEdits");
    const r = await say(s.id, 'CALL github__search_issues {"repo":"acme/app","q":"bug"}');
    assert.equal(r.calls[0].result, "search_issues ok");
    assert.deepEqual(mcp.calls.at(-1), {
      name: "search_issues",
      arguments: { repo: "acme/app", q: "bug" },
    });
  });

  test("a REST tool's call is rebuilt from the route: path, query, header, and the key the model never sees", async () => {
    const s = await start("olga", "triager", "default");
    const r = await say(
      s.id,
      'CALL weather__forecast {"city":"paris","days":3,"X-Units":"metric"}',
    );
    assert.match(r.calls[0].result, /temps/);
    assert.deepEqual(weather.requests.at(-1), {
      method: "GET",
      url: "/forecast/paris?days=3",
      units: "metric",
      key: "wk-secret",
      body: "",
    });
    const missing = await say(s.id, 'CALL weather__forecast {"city":"nowhere"}');
    assert.ok(missing.calls[0].isError);
    assert.match(missing.calls[0].result, /HTTP 404/);
    // the model's view of the tool has no key and no HTTP detail
    const def = (await p.call("GET", `/v1/sessions/${s.id}/tools`)).body.definitions.find(
      (d) => d[NS].id === "weather/forecast",
    );
    assert.ok(!JSON.stringify(def.paths).includes("X-Api-Key"));
  });

  test("a harness tool reaches the project's members only through the harness", async () => {
    const s = await start("alice", "coder", "default");
    const r = await say(s.id, "CALL harness__members_list {}");
    assert.match(r.calls[0].result, /"alice":"editor"/);
  });
});
