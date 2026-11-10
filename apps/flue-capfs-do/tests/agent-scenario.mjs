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
  const ask = (ws, token, transport, task, chain = [], agent = `ag-${ws}`, llmToken) =>
    api(
      `/api/agents/${agent}/run`,
      { workspace: ws, token, transport, chain, task: { kind: "agent", ...task } },
      llmToken === undefined ? {} : { headers: { "x-llm-token": llmToken } },
    );
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

  add("a run that ends on its last allowed turn is not a limit stop", async () => {
    const { ws, token } = await setup();
    const r = ok(await ask(ws, token, "token", { prompt: "READ /proj/readme.md", maxTurns: 2 }));
    assert.equal(r.stopReason, "stop");
    assert.equal(r.turns, 2);
    assert.equal(r.error, undefined);
    assert.match(r.reply, /^RESULT: /);
  });

  add("a run stops at its timeout", async () => {
    const { ws, token } = await setup();
    const t0 = Date.now();
    const r = ok(await ask(ws, token, "token", { prompt: "SLOW", timeoutMs: 1000 }));
    assert.equal(r.stopReason, "limit");
    assert.match(r.error, /1000 ms/);
    assert.ok(Date.now() - t0 < 2900, "the abort cut the model call short");
  });

  add("tool results are paired with their calls (two calls in one turn)", async () => {
    const { ws, token } = await setup();
    const r = ok(await ask(ws, token, "token", { prompt: "TWO /proj/readme.md /p10/secret.txt" }));
    assert.deepEqual(
      r.toolCalls.map((c) => [c.arguments.path, c.isError]),
      [
        ["/proj/readme.md", false],
        ["/p10/secret.txt", true],
      ],
    );
    assert.match(r.toolCalls[0].result, /# proj/);
    assert.doesNotMatch(r.toolCalls[1].result, /# proj|p10 secret/);
  });

  add("the deployment's key reaches the model endpoint", async () => {
    const { ws, token } = await setup();
    const r = ok(await ask(ws, token, "token", { prompt: "KEY" }));
    assert.equal(r.reply, "KEY: Bearer sk-fake");
  });

  for (const transport of transports)
    add(
      `[${transport}] the caller's model token goes down the chain to the model call`,
      async () => {
        const { ws, token } = await setup();
        const key = (chain, llmToken) =>
          ask(ws, token, transport, { prompt: "KEY" }, chain, undefined, llmToken).then(ok);
        assert.equal((await key([], "user-tok-1")).reply, "KEY: Bearer user-tok-1");
        const two = [{ readOnly: true }, { scope: "/proj" }];
        assert.equal((await key(two, "user-tok-1")).reply, "KEY: Bearer user-tok-1", "two hops");
        // A hop can hand down its own credential instead.
        const own = [{ readOnly: true }, { scope: "/proj", llmToken: "hop-tok-2" }];
        assert.equal((await key(own, "user-tok-1")).reply, "KEY: Bearer hop-tok-2");
        assert.equal((await key(own)).reply, "KEY: Bearer hop-tok-2");
        assert.equal((await key([])).reply, "KEY: Bearer sk-fake", "without one: the deployment's");
        // A hop that only hands down a token keeps the capability as it is.
        const only = await key([{ llmToken: "hop-only-5" }], "user-tok-1");
        assert.equal(only.reply, "KEY: Bearer hop-only-5");
      },
    );

  add("model tokens: refused when malformed, kept out of errors and sessions", async () => {
    const { ws, token } = await setup();
    const bad = await ask(ws, token, "token", { prompt: "KEY" }, [], undefined, "a b");
    assert.equal(bad.code, "EINVAL");
    assert.equal(
      (await ask(ws, token, "token", { prompt: "KEY" }, [], undefined, "short")).code,
      "EINVAL",
    );
    const r = ok(await ask(ws, token, "token", { prompt: "FAIL" }, [], undefined, "user-tok-3"));
    assert.match(r.error, /<redacted>/, "the provider's error is reported, redacted");
    assert.doesNotMatch(JSON.stringify(r), /user-tok-3/);
    const dep = ok(await ask(ws, token, "token", { prompt: "FAIL", session: "f1" }));
    assert.match(dep.error, /<redacted>/);
    assert.doesNotMatch(JSON.stringify(dep), /sk-fake/, "nor the deployment's key");
    const after = ok(await ask(ws, token, "token", { prompt: "HISTORY", session: "f1" }));
    // system, FAIL (its failed reply is not kept), HISTORY
    assert.equal(after.reply, "MESSAGES: 3");
    // A session through a hop with its own token is the same session as without the token.
    const chain = (t) => [{ readOnly: true, ...(t ? { llmToken: t } : {}) }];
    ok(await ask(ws, token, "token", { prompt: "OK", session: "t1" }, chain("hop-tok-4")));
    const again = ok(await ask(ws, token, "token", { prompt: "HISTORY", session: "t1" }, chain()));
    assert.equal(again.reply, "MESSAGES: 4", "the token is not part of the session's key");
  });

  add("a session continues for its capability, and starts fresh for another", async () => {
    const { ws, token } = await setup();
    ok(await ask(ws, token, "token", { prompt: "READ /proj/readme.md", session: "s1" }));
    const again = ok(await ask(ws, token, "token", { prompt: "HISTORY", session: "s1" }));
    // Sent to the model: system, then the stored user, assistant (tool call), tool result,
    // assistant, and the new user message.
    assert.equal(again.reply, "MESSAGES: 6");
    // Stored after the run: those five without the system prompt, plus HISTORY's two.
    assert.equal(again.session.messages, 6);
    const other = await admin(`/api/w/${ws}/sessions`, { user: "bob", rights: ["/proj"] });
    const bob = ok(await ask(ws, other.token, "token", { prompt: "HISTORY", session: "s1" }));
    assert.equal(bob.reply, "MESSAGES: 2", "bob does not see alice's conversation");
  });

  add("a session continues through the same delegation chain, not through another", async () => {
    const { ws, token } = await setup();
    const chain = [{ readOnly: true }];
    ok(await ask(ws, token, "token", { prompt: "READ /proj/readme.md", session: "c1" }, chain));
    const again = ok(await ask(ws, token, "token", { prompt: "HISTORY", session: "c1" }, chain));
    assert.equal(again.reply, "MESSAGES: 6", "the chain's fresh block keys do not reset it");
    const direct = ok(await ask(ws, token, "token", { prompt: "HISTORY", session: "c1" }));
    assert.equal(direct.reply, "MESSAGES: 2", "without the chain it is another conversation");
    const scoped = ok(
      await ask(ws, token, "token", { prompt: "HISTORY", session: "c1" }, [{ scope: "/proj" }]),
    );
    assert.equal(scoped.reply, "MESSAGES: 2", "another chain is another conversation");
  });

  return cases;
}
