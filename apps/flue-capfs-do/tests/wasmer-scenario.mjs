// Wasmer sandboxes on the capability file system: the `wasmer` task (a bash script), and the
// `agent` task with `sandbox: "wasmer"` (Flue's tools on Wasmer). Shared by tests/wasmer.test.mjs
// (HTTP) and tests/browser.test.mjs. The guest's /workspace IS the capability: every file
// operation it makes is authorized by the Workspace cell.
import assert from "node:assert/strict";
import { patternChunks } from "../src/stream-task.ts";

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

  add("a large directory is listed in one capability call", async () => {
    const { ws, token } = await setup();
    const made = await sh(
      ws,
      token,
      "mkdir -p /workspace/proj/many && cd /workspace/proj/many && for i in $(seq 1 300); do echo $i > f$i.txt; done; ls | wc -l; ls -l f300.txt",
    );
    assert.equal(made.exitCode, 0, made.stderr);
    assert.match(made.stdout, /^300\n/);
    assert.match(made.stdout, / 4 .*f300\.txt/);
  });

  add("NUL bytes written in Wasmer are kept by the store", async () => {
    const { ws, token } = await setup();
    const r = await sh(
      ws,
      token,
      "printf 'a\\0b' > /workspace/proj/nul; wc -c < /workspace/proj/nul",
    );
    assert.equal(r.exitCode, 0, r.stderr);
    assert.equal(r.stdout.trim(), "3");
    assert.equal((await files(ws))["/proj/nul"], "a\u0000b");
  });

  add("the guest's own `wasmer` command cannot fetch packages", async () => {
    const { ws, token } = await setup();
    const r = await sh(ws, token, "wasmer run syrusakbary/cowsay moo 2>&1; echo rc=$?");
    assert.doesNotMatch(r.stdout, /< moo >/);
  });

  add("a write the capability refuses fails at the write, not silently at close", async () => {
    const { ws, token } = await setup();
    const r = await sh(
      ws,
      token,
      "echo more >> /workspace/proj/readme.md; echo rc=$?; printf '\\xff' > /workspace/proj/b.bin; echo rc=$?",
      [{ readOnly: true }],
    );
    assert.match(r.stdout, /^rc=1\n/, r.stderr);
    const f = await files(ws);
    assert.equal(f["/proj/readme.md"], SEED["/proj/readme.md"]);
    assert.equal(f["/proj/b.bin"], undefined);
  });

  add(
    "a file larger than a whole-file read streams into Wasmer (wc, tail), and appends (>>) to it",
    async () => {
      const { ws, token } = await setup();
      const size = 20 * 1024 * 1024 + 3; // more than the 16 MiB a whole-file call moves
      const w = await run(ws, token, {
        kind: "stream",
        op: "write",
        path: "/proj/big.bin",
        size,
        seed: 5,
      });
      assert.equal(w.ok, true, w.error);
      const r = await sh(
        ws,
        token,
        "wc -c < /workspace/proj/big.bin; tail -c 4 /workspace/proj/big.bin | od -An -tu1",
      );
      assert.equal(r.exitCode, 0, r.stderr);
      const [count, tail] = r.stdout.trim().split("\n");
      assert.equal(count.trim(), String(size));
      const last = Buffer.concat([...patternChunks(size, 5, 1 << 20)]).subarray(-4);
      assert.deepEqual(tail.trim().split(/\s+/).map(Number), [...last]);
      // Appending (>>) streams to the store: the file is not loaded, so its size is no limit.
      const a = await sh(
        ws,
        token,
        "printf ABC >> /workspace/proj/big.bin; printf DE >> /workspace/proj/big.bin; wc -c < /workspace/proj/big.bin; tail -c 7 /workspace/proj/big.bin | od -An -tu1",
      );
      assert.equal(a.exitCode, 0, a.stderr);
      const [count2, tail2] = a.stdout.trim().split("\n");
      assert.equal(count2.trim(), String(size + 5));
      assert.deepEqual(
        tail2.trim().split(/\s+/).map(Number),
        [...last.subarray(-2), ..."ABCDE"].map((c) =>
          typeof c === "string" ? c.charCodeAt(0) : c,
        ),
      );
    },
  );

  add("binary files are stored byte for byte from Wasmer", async () => {
    const { ws, token } = await setup();
    const w = await sh(
      ws,
      token,
      "printf '\\377\\376\\000\\001' > /workspace/proj/b.bin; cp /workspace/proj/b.bin /workspace/proj/c.bin; wc -c < /workspace/proj/c.bin; od -An -tx1 /workspace/proj/b.bin",
    );
    assert.equal(w.exitCode, 0, w.stderr);
    assert.match(w.stdout, /^4\n\s*ff fe 00 01/);
    const b64 = await admin(`/api/w/${ws}/files?encoding=base64`);
    assert.equal(b64["/proj/b.bin"], Buffer.from([0xff, 0xfe, 0, 1]).toString("base64"));
    assert.equal(b64["/proj/c.bin"], b64["/proj/b.bin"]);
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
