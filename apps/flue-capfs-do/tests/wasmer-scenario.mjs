// Wasmer sandboxes on the capability file system: the `wasmer` task (a bash script), and the
// `agent` task with `sandbox: "wasmer"` (Flue's tools on Wasmer). Shared by tests/wasmer.test.mjs
// (HTTP) and tests/browser.test.mjs. The guest's /workspace IS the capability: every file
// operation it makes is authorized by the Workspace cell.
import assert from "node:assert/strict";

const SEED = {
  "/proj/readme.md": "# proj\nTODO: write tests\n",
  "/proj/src/a.ts": "export const a = 1; // TODO: rename\n",
  "/p10/secret.txt": "p10 secret TODO\n",
};
let n = 0;

export function wasmerCases({ api, label = "", llm = false }) {
  const RUN = `${label}${Date.now().toString(36)}`;
  const admin = async (path, body) => {
    const r = await api(path, body, { admin: true });
    assert.equal(r.ok, true, `${path}: ${r.error}`);
    return r.value;
  };
  const setup = async (rights = ["/proj"]) => {
    const ws = `wm-${RUN}-${++n}`;
    await admin(`/api/w/${ws}/seed`, { files: SEED });
    return {
      ws,
      ...(await admin(`/api/w/${ws}/sessions`, { user: "alice", rights, model: true })),
    };
  };
  const files = (ws) => admin(`/api/w/${ws}/files`);
  const run = (ws, token, task, chain = [], transport = "token") =>
    api(`/api/agents/wm-${ws}/run`, { workspace: ws, token, transport, chain, task });
  const sh = async (ws, token, script, chain, transport) => {
    const r = await run(ws, token, { kind: "wasmer", script, timeoutMs: 60000 }, chain, transport);
    assert.equal(r.ok, true, r.error);
    return r.value.result;
  };
  const cases = [];
  const add = (name, fn) => cases.push({ name, fn });

  for (const transport of ["stub", "token"])
    add(
      `[${transport}] bash in Wasmer reads and lists only what the capability allows`,
      async () => {
        const { ws, token } = await setup();
        const ls = await sh(
          ws,
          token,
          "ls /workspace; cat /workspace/proj/readme.md",
          [],
          transport,
        );
        assert.equal(ls.exitCode, 0, ls.stderr);
        assert.match(ls.stdout, /^proj\n/);
        assert.match(ls.stdout, /TODO: write tests/);
        assert.doesNotMatch(ls.stdout, /p10/);
        const secret = await sh(ws, token, "cat /workspace/p10/secret.txt", [], transport);
        assert.notEqual(secret.exitCode, 0);
        assert.doesNotMatch(secret.stdout, /p10 secret/);
        const rg = await sh(ws, token, "rg -n TODO /workspace | sort", [], transport);
        assert.match(rg.stdout, /proj\/readme\.md:2:TODO/);
        assert.match(rg.stdout, /proj\/src\/a\.ts:1:/);
        assert.doesNotMatch(rg.stdout, /p10/);
      },
    );

  add(
    "writes go through the capability: allowed under /proj, refused elsewhere and read-only",
    async () => {
      const { ws, token } = await setup();
      const w = await sh(
        ws,
        token,
        "cd /workspace/proj && echo made by bash > out.txt && mkdir -p d && echo x > d/y.txt && wc -l readme.md",
      );
      assert.equal(w.exitCode, 0, w.stderr);
      assert.match(w.stdout, /2 readme\.md/);
      const f = await files(ws);
      assert.equal(f["/proj/out.txt"], "made by bash\n");
      assert.equal(f["/proj/d/y.txt"], "x\n");
      const outside = await sh(ws, token, "echo no > /workspace/p10/x.txt");
      assert.notEqual(outside.exitCode, 0);
      const ro = await sh(ws, token, "echo no > /workspace/proj/ro.txt", [{ readOnly: true }]);
      assert.notEqual(ro.exitCode, 0);
      assert.match(ro.stderr, /denied|not permitted|No such file/i);
      const after = await files(ws);
      assert.equal(after["/p10/x.txt"], undefined);
      assert.equal(after["/proj/ro.txt"], undefined);
    },
  );

  add("each run is its own sandbox; a package outside WASMER_PACKAGES is refused", async () => {
    const { ws, token } = await setup();
    await sh(ws, token, "echo one > /tmp/x; echo one > /workspace/proj/x.txt");
    const second = await sh(ws, token, "cat /tmp/x; cat /workspace/proj/x.txt");
    assert.doesNotMatch(second.stdout, /^one\none/, "nothing outside /workspace survives a run");
    assert.match(second.stdout, /one/);
    const r = await run(ws, token, { kind: "wasmer", script: "true", packages: ["evil/pkg"] });
    assert.equal(r.code, "EPERM", r.error);
  });

  if (llm)
    add("the agent task runs Flue's tools on Wasmer (sandbox: wasmer)", async () => {
      const { ws, token } = await setup();
      const ask = async (prompt) => {
        const r = await run(ws, token, { kind: "agent", prompt, sandbox: "wasmer" });
        assert.equal(r.ok, true, r.error);
        return r.value.result;
      };
      const read = await ask("READ /workspace/proj/readme.md");
      assert.match(read.reply, /TODO: write tests/);
      const denied = await ask("READ /workspace/p10/secret.txt");
      assert.equal(denied.toolCalls[0].isError, true);
      const bash = await ask("BASH rg -c TODO /workspace");
      assert.match(bash.reply, /proj/);
      assert.doesNotMatch(bash.reply, /p10/);
      await ask("WRITE /workspace/proj/notes.md written by a Flue tool on Wasmer");
      assert.equal((await files(ws))["/proj/notes.md"], "written by a Flue tool on Wasmer");
    });

  return cases;
}
