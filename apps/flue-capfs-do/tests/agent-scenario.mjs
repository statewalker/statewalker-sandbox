// The `agent` task: an LLM loop (pi-agent-core) with Flue's tools on the capability file system.
// The model is the fake endpoint of tests/helpers/fake-llm.mjs, configured by the runner as the
// LLM var; its commands (READ/WRITE/BASH/LOOP/HISTORY) make the model's moves predictable.
// `api(path, body?, { admin })` → { status, ok, value | code, error }.
import assert from "node:assert/strict";

const SEED = {
  "/proj/readme.md": "# proj\nTODO: write tests\n",
  "/p10/secret.txt": "p10 secret\n",
};
let n = 0;

export function agentCases({ api, transports = ["stub", "token"], label = "" }) {
  const RUN = `${label}${Date.now().toString(36)}`;
  const admin = async (path, body) => {
    const r = await api(path, body, { admin: true });
    assert.equal(r.ok, true, `${path}: ${r.error}`);
    return r.value;
  };
  const setup = async (rights = ["/proj"]) => {
    const ws = `ag-${RUN}-${++n}`;
    await admin(`/api/w/${ws}/seed`, { files: SEED });
    return { ws, ...(await admin(`/api/w/${ws}/sessions`, { user: "alice", rights })) };
  };
  const files = (ws) => admin(`/api/w/${ws}/files`);
  const ask = (ws, token, transport, task, chain = [], agent = `ag-${ws}`) =>
    api(`/api/agents/${agent}/run`, {
      workspace: ws,
      token,
      transport,
      chain,
      task: { kind: "agent", ...task },
    });
  const ok = (r) => {
    assert.equal(r.ok, true, r.error);
    return r.value.result;
  };
  const cases = [];
  const add = (name, fn) => cases.push({ name, fn });

  for (const transport of transports) {
    add(`[${transport}] the model reads through Flue's read tool, within the rights`, async () => {
      const { ws, token } = await setup();
      const r = ok(await ask(ws, token, transport, { prompt: "READ /proj/readme.md" }));
      assert.deepEqual(
        r.toolCalls.map((c) => [c.tool, c.isError]),
        [["read", false]],
      );
      assert.match(r.reply, /^RESULT: .*# proj/s);
      assert.match(r.reply, /TODO: write tests/);
      assert.equal(r.stopReason, "stop");
    });

    add(
      `[${transport}] outside the rights the tool fails, and nothing leaks into the reply`,
      async () => {
        const { ws, token } = await setup();
        const r = ok(await ask(ws, token, transport, { prompt: "READ /p10/secret.txt" }));
        assert.equal(r.toolCalls[0].tool, "read");
        assert.equal(r.toolCalls[0].isError, true);
        assert.doesNotMatch(r.reply, /p10 secret/);
        const ls = ok(await ask(ws, token, transport, { prompt: "BASH ls /" }));
        assert.match(ls.reply, /RESULT: proj/);
        assert.doesNotMatch(ls.reply, /p10/);
      },
    );

    add(
      `[${transport}] writes follow the capability: allowed, then refused in a read-only delegation`,
      async () => {
        const { ws, token } = await setup();
        ok(
          await ask(ws, token, transport, { prompt: "WRITE /proj/notes.md written by the model" }),
        );
        assert.equal((await files(ws))["/proj/notes.md"], "written by the model");
        const r = ok(
          await ask(ws, token, transport, { prompt: "WRITE /proj/other.md nope" }, [
            { readOnly: true },
          ]),
        );
        assert.equal(r.toolCalls[0].isError, true);
        assert.equal((await files(ws))["/proj/other.md"], undefined);
      },
    );
  }

  add("a run stops after maxTurns", async () => {
    const { ws, token } = await setup();
    const r = ok(await ask(ws, token, "token", { prompt: "LOOP", maxTurns: 3 }));
    assert.equal(r.stopReason, "limit");
    assert.equal(r.turns, 3);
    assert.match(r.error, /3 turns/);
  });

  add("a session continues for its capability, and starts fresh for another", async () => {
    const { ws, token } = await setup();
    ok(await ask(ws, token, "token", { prompt: "READ /proj/readme.md", session: "s1" }));
    const again = ok(await ask(ws, token, "token", { prompt: "HISTORY", session: "s1" }));
    // system, user, assistant (tool call), tool result, assistant, user
    assert.equal(again.reply, "MESSAGES: 6");
    assert.equal(again.session.messages, 6);
    const other = await admin(`/api/w/${ws}/sessions`, { user: "bob", rights: ["/proj"] });
    const bob = ok(await ask(ws, other.token, "token", { prompt: "HISTORY", session: "s1" }));
    assert.equal(bob.reply, "MESSAGES: 2", "bob does not see alice's conversation");
  });

  return cases;
}
