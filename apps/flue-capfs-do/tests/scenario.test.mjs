// One scenario suite, run unchanged against every runtime that serves the Worker project:
//   BASE_URL=http://127.0.0.1:8787 node --test tests/scenario.test.mjs
// TRANSPORTS=stub,token (default) selects the capability transports to exercise.
// scripts/run-env.mjs starts a runtime (wrangler | cellb | celld) and runs this file.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { Biscuit, generateKeypair } from "@statewalker/webrun-biscuit";

const BASE = process.env.BASE_URL ?? "http://127.0.0.1:8787";
const ADMIN = process.env.ADMIN_KEY ?? "dev-admin-key";
const TRANSPORTS = (process.env.TRANSPORTS ?? "stub,token").split(",").filter(Boolean);
const RUN = Date.now().toString(36);
let n = 0;
const freshWs = () => `ws-${RUN}-${++n}`;

async function http(path, body, { admin = false, method } = {}) {
  const headers = { "content-type": "application/json" };
  if (admin) headers.authorization = `Bearer ${ADMIN}`;
  const res = await fetch(`${BASE}${path}`, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json();
  return { status: res.status, ...json };
}
const admin = async (path, body) => {
  const r = await http(path, body, { admin: true });
  assert.equal(r.ok, true, `${path}: ${r.error}`);
  return r.value;
};
const seed = (ws, files) => admin(`/api/w/${ws}/seed`, { files });
const session = (ws, user, rights, mode) => admin(`/api/w/${ws}/sessions`, { user, rights, mode });
const setMode = (ws, sid, mode) => admin(`/api/w/${ws}/sessions/${sid}/mode`, { mode });
const revoke = (ws, sid, rid) => admin(`/api/w/${ws}/sessions/${sid}/revoke`, rid ? { rid } : {});
const files = (ws) => admin(`/api/w/${ws}/files`);

const run = (agent, ws, token, transport, task, chain = []) =>
  http(`/api/agents/${agent}/run`, { workspace: ws, token, transport, chain, task });
async function sh(agent, ws, token, transport, script, opts = {}) {
  const r = await run(
    agent,
    ws,
    token,
    transport,
    { kind: "bash", script, cwd: opts.cwd },
    opts.chain,
  );
  assert.equal(r.ok, true, `run failed: ${r.error}`);
  return r.value.result;
}

const SEED = {
  "/p1/a.txt": "hello p1\n",
  "/p10/secret.txt": "p10 secret\n",
  "/p3/shared.txt": "shared\n",
  "/proj/readme.md": "# proj\nTODO: write tests\n",
  "/proj/src/main.js": "console.log('main'); // TODO\n",
  "/plans/.keep": "",
};

test("runtime answers", async () => {
  const r = await http("/api/runtime");
  assert.equal(r.ok, true);
  console.log(`# runtime: ${JSON.stringify(r.value)}`);
});

test("admin routes need the admin key", async () => {
  const r = await http(`/api/w/${freshWs()}/files`);
  assert.equal(r.status, 401);
});

for (const transport of TRANSPORTS) {
  describe(`transport=${transport}`, () => {
    test("rights: only allowed branches exist for the agent; exact prefixes; '..' cannot escape", async () => {
      const ws = freshWs();
      await seed(ws, SEED);
      const { token } = await session(ws, "alice", ["/p1", "/proj"]);
      const r = await sh(
        `alice-${ws}`,
        ws,
        token,
        transport,
        "ls /; cat /p1/a.txt; grep -r TODO /proj",
      );
      assert.equal(r.exitCode, 0, r.stderr);
      assert.equal(r.stdout.split("\n")[0], "p1");
      assert.match(r.stdout, /^p1\nproj\nhello p1\n/);
      assert.match(r.stdout, /\/proj\/readme\.md:TODO: write tests/);
      assert.match(r.stdout, /\/proj\/src\/main\.js:.*TODO/);

      const p10 = await sh(`alice-${ws}`, ws, token, transport, "cat /p10/secret.txt");
      assert.notEqual(p10.exitCode, 0);
      assert.doesNotMatch(p10.stdout, /secret/);

      const esc = await sh(
        `alice-${ws}`,
        ws,
        token,
        transport,
        "cat /p1/../p10/secret.txt; cat /../../p10/secret.txt",
      );
      assert.doesNotMatch(esc.stdout, /secret/);

      const w = await sh(`alice-${ws}`, ws, token, transport, "echo pwned > /p10/x.txt");
      assert.notEqual(w.exitCode, 0);
      assert.equal((await files(ws))["/p10/x.txt"], undefined);
    });

    test("forged, tampered and foreign tokens are refused", async () => {
      const ws = freshWs();
      await seed(ws, SEED);
      const { token } = await session(ws, "alice", ["/p1"]);
      // A token minted with another root key, claiming everything.
      const other = generateKeypair();
      const forged = Biscuit.build(
        other.secretKey,
        `user("mallory");session("x");right("/");`,
      ).toBase64();
      const r1 = await run(`m-${ws}`, ws, forged, transport, {
        kind: "bash",
        script: "cat /p10/secret.txt",
      });
      if (r1.ok) assert.doesNotMatch(r1.value.result.stdout, /secret/);
      else assert.equal(r1.code, "EACCES");
      // A valid token of ANOTHER workspace.
      const ws2 = freshWs();
      await seed(ws2, SEED);
      const { token: t2 } = await session(ws2, "alice", ["/"]);
      const r2 = await run(`m2-${ws}`, ws, t2, transport, {
        kind: "bash",
        script: "cat /p10/secret.txt",
      });
      if (r2.ok) assert.doesNotMatch(r2.value.result.stdout, /secret/);
      else assert.equal(r2.code, "EACCES");
      // Tampered bytes.
      const bad = token.slice(0, 40) + (token[40] === "A" ? "B" : "A") + token.slice(41);
      const r3 = await run(`m3-${ws}`, ws, bad, transport, {
        kind: "bash",
        script: "cat /p1/a.txt",
      });
      if (r3.ok) assert.doesNotMatch(r3.value.result.stdout, /hello/);
      else assert.equal(r3.code, "EACCES");
      // A delegated block cannot widen: right("/") added in an attenuation block grants nothing.
      const widened = Biscuit.fromBase64(token).attenuate(`right("/");`).toBase64();
      const r4 = await sh(`m4-${ws}`, ws, widened, transport, "cat /p10/secret.txt; cat /p1/a.txt");
      assert.doesNotMatch(r4.stdout, /secret/);
    });

    test("modes switch at runtime, both ways, for one session only", async () => {
      const ws = freshWs();
      await seed(ws, SEED);
      const a = await session(ws, "alice", ["/proj", "/plans"], "yolo");
      const b = await session(ws, "bob", ["/proj", "/plans"], "yolo");
      const write = (tok, who, file) =>
        sh(`${who}-${ws}`, ws, tok, transport, `echo ${who} >> ${file}`);

      assert.equal((await write(a.token, "alice", "/proj/a1.txt")).exitCode, 0);
      await setMode(ws, a.session, "plan");
      assert.notEqual(
        (await write(a.token, "alice", "/proj/a2.txt")).exitCode,
        0,
        "plan mode refuses /proj",
      );
      assert.equal(
        (await write(a.token, "alice", "/plans/p.md")).exitCode,
        0,
        "plan mode allows /plans",
      );
      assert.equal((await write(b.token, "bob", "/proj/b1.txt")).exitCode, 0, "bob is unaffected");
      await setMode(ws, a.session, "readonly");
      assert.notEqual((await write(a.token, "alice", "/plans/p2.md")).exitCode, 0);
      const rd = await sh(`alice-${ws}`, ws, a.token, transport, "cat /proj/readme.md");
      assert.equal(rd.exitCode, 0);
      await setMode(ws, a.session, "yolo");
      assert.equal((await write(a.token, "alice", "/proj/a3.txt")).exitCode, 0, "back to yolo");

      const all = await files(ws);
      assert.ok(
        all["/proj/a1.txt"] && all["/proj/a3.txt"] && all["/plans/p.md"] && all["/proj/b1.txt"],
      );
      assert.equal(all["/proj/a2.txt"], undefined);
      assert.equal(all["/plans/p2.md"], undefined);
    });

    test("Flue's own tools (read/write/edit/grep/glob/bash) run on the filtered file system", async () => {
      const ws = freshWs();
      await seed(ws, SEED);
      const { token } = await session(ws, "alice", ["/p1", "/proj"]);
      const r = await run(`flue-${ws}`, ws, token, transport, {
        kind: "flue",
        cwd: "/proj",
        calls: [
          { tool: "read", params: { path: "/proj/readme.md" } },
          { tool: "write", params: { path: "/proj/notes.md", content: "draft 1\n" } },
          {
            tool: "edit",
            params: { path: "/proj/notes.md", oldText: "draft 1", newText: "draft 2" },
          },
          { tool: "grep", params: { pattern: "TODO", path: "/proj" } },
          { tool: "glob", params: { pattern: "*.md", path: "/proj" } },
          { tool: "bash", params: { command: "ls /; cat /proj/notes.md" } },
          { tool: "write", params: { path: "/p10/evil.md", content: "x" } },
          { tool: "read", params: { path: "/p10/secret.txt" } },
          { tool: "glob", params: { pattern: "*", path: "/" } },
        ],
      });
      assert.equal(r.ok, true, r.error);
      const [read, write, edit, grep, glob, bash, evil, steal, globAll] = r.value.result;
      assert.equal(read.isError, false, read.text);
      assert.match(read.text, /TODO: write tests/);
      assert.equal(write.isError, false, write.text);
      assert.equal(edit.isError, false, edit.text);
      assert.equal(grep.isError, false, grep.text);
      assert.match(grep.text, /readme\.md/);
      assert.equal(glob.isError, false, glob.text);
      assert.match(glob.text, /notes\.md/);
      assert.equal(bash.isError, false, bash.text);
      assert.match(bash.text, /p1\nproj\ndraft 2/);
      assert.equal(evil.isError, true);
      assert.equal(steal.isError, true);
      assert.doesNotMatch(steal.text, /p10 secret/);
      assert.doesNotMatch(globAll.text, /p10|secret/);
      assert.equal((await files(ws))["/proj/notes.md"], "draft 2\n");
    });

    test("delegation across three cells only narrows; the parent keeps its rights", async () => {
      const ws = freshWs();
      await seed(ws, SEED);
      const { token } = await session(ws, "alice", ["/p1", "/proj"]);
      const chain = [{ scope: "/proj" }, { readOnly: true }];
      const r = await run(
        `d-${ws}`,
        ws,
        token,
        transport,
        { kind: "bash", script: "ls /; cat /proj/readme.md; cat /p1/a.txt" },
        chain,
      );
      assert.equal(r.ok, true, r.error);
      assert.deepEqual(r.value.hops, [`d-${ws}`, `d-${ws}/sub`, `d-${ws}/sub/sub`]);
      assert.match(r.value.result.stdout, /^proj\n# proj/);
      assert.doesNotMatch(r.value.result.stdout, /hello p1/);
      const w = await sh(`d-${ws}`, ws, token, transport, "echo x > /proj/sub.txt", { chain });
      assert.notEqual(w.exitCode, 0);
      // One hop (scope only) may write in /proj but not in /p1.
      const w1 = await sh(`d-${ws}`, ws, token, transport, "echo hop1 > /proj/hop1.txt", {
        chain: [{ scope: "/proj" }],
      });
      assert.equal(w1.exitCode, 0, w1.stderr);
      const w2 = await sh(`d-${ws}`, ws, token, transport, "echo hop1 > /p1/hop1.txt", {
        chain: [{ scope: "/proj" }],
      });
      assert.notEqual(w2.exitCode, 0);
      // The parent is unchanged.
      const p = await sh(
        `d-${ws}`,
        ws,
        token,
        transport,
        "echo parent > /p1/parent.txt && cat /p1/parent.txt",
      );
      assert.equal(p.stdout, "parent\n");
      const all = await files(ws);
      assert.equal(all["/proj/sub.txt"], undefined);
      assert.equal(all["/p1/hop1.txt"], undefined);
      assert.equal(all["/proj/hop1.txt"], "hop1\n");
    });

    test("revoking one delegated capability cuts it and its descendants, not its parent", async () => {
      const ws = freshWs();
      await seed(ws, SEED);
      const { token, session: sid } = await session(ws, "alice", ["/p1", "/proj"]);
      // The holder delegates offline: appending a block needs no key.
      const child = Biscuit.fromBase64(token)
        .attenuate(`check if resource($p), $p.starts_with("/proj/");`)
        .toBase64();
      const grandchild = Biscuit.fromBase64(child)
        .attenuate(`check if operation($o), ["read","list"].contains($o);`)
        .toBase64();
      assert.equal(
        (await sh(`r-${ws}`, ws, grandchild, transport, "cat /proj/readme.md")).exitCode,
        0,
      );
      const rid = (await run(`r-${ws}`, ws, child, transport, { kind: "revocationId" })).value
        .result;
      assert.match(rid, /^[0-9a-f]{64,}$/);
      await revoke(ws, sid, rid);
      for (const t of [child, grandchild]) {
        const r = await run(`r-${ws}`, ws, t, transport, {
          kind: "bash",
          script: "cat /proj/readme.md",
        });
        if (r.ok) assert.doesNotMatch(r.value.result.stdout, /proj/);
        else assert.equal(r.code, "EACCES");
      }
      assert.equal(
        (await sh(`r-${ws}`, ws, token, transport, "cat /proj/readme.md")).exitCode,
        0,
        "parent still works",
      );
      // Revoking the whole session cuts everything.
      await revoke(ws, sid);
      const r = await run(`r-${ws}`, ws, token, transport, {
        kind: "bash",
        script: "cat /proj/readme.md",
      });
      if (r.ok) assert.doesNotMatch(r.value.result.stdout, /proj/);
      else assert.equal(r.code, "EACCES");
    });

    test("parallel users on one store: independent views, no lost appends", async () => {
      const ws = freshWs();
      await seed(ws, SEED);
      const users = {
        alice: await session(ws, "alice", ["/p1", "/p3"]),
        bob: await session(ws, "bob", ["/p3", "/proj"]),
        carol: await session(ws, "carol", ["/"]),
      };
      const N = 5;
      const jobs = [];
      for (const [who, s] of Object.entries(users)) {
        for (let i = 0; i < N; i++)
          jobs.push(
            sh(`${who}-${ws}-${i % 2}`, ws, s.token, transport, `echo ${who}-${i} >> /p3/log.txt`),
          );
      }
      jobs.push(sh(`bob-${ws}-x`, ws, users.bob.token, transport, "echo bob > /p1/bob.txt"));
      const results = await Promise.all(jobs);
      assert.equal(results.slice(0, -1).filter((r) => r.exitCode !== 0).length, 0);
      assert.notEqual(results.at(-1).exitCode, 0);
      const log = (await files(ws))["/p3/log.txt"].trim().split("\n").sort();
      assert.equal(log.length, 3 * N, "no lost appends");
      const views = await Promise.all(
        Object.entries(users).map(([who, s]) =>
          sh(`${who}-${ws}-v`, ws, s.token, transport, "ls /"),
        ),
      );
      assert.deepEqual(
        views.map((v) => v.stdout.trim().split("\n")),
        [
          ["p1", "p3"],
          ["p3", "proj"],
          ["p1", "p10", "p3", "plans", "proj"],
        ],
      );
    });

    test("tool code in a Worker Loader isolate holds only the narrowed capability", async (t) => {
      const rt = (await http("/api/runtime")).value;
      if (!rt.workerLoader) return t.skip("no Worker Loader binding in this runtime");
      const ws = freshWs();
      await seed(ws, SEED);
      const { token } = await session(ws, "alice", ["/p1", "/proj"]);
      const code = `import { WorkerEntrypoint } from "cloudflare:workers";
export default class extends WorkerEntrypoint {
  async run(files, input) {
    const out = { list: await files.readdir("/proj") };
    out.readme = await files.call("readFile", "/proj/readme.md");
    try { await files.call("writeFile", "/proj/tool.txt", "x"); out.write = "allowed"; } catch (e) { out.write = String(e.message); }
    try { await files.call("readFile", "/p1/a.txt"); out.p1 = "readable"; } catch (e) { out.p1 = String(e.message); }
    try { await files.attenuate('check if true;'); out.attenuate = "allowed"; } catch (e) { out.attenuate = "refused"; }
    out.process = typeof globalThis.process;
    try { const fs = await import("node:fs"); out.nodeFsRoot = fs.readdirSync("/"); } catch (e) { out.nodeFsRoot = "unavailable: " + e.message; }
    try { await fetch("https://example.com/"); out.fetch = "allowed"; } catch (e) { out.fetch = "blocked"; }
    return out;
  }
}`;
      const r = await run(`tool-${ws}`, ws, token, transport, { kind: "tool", code }, [
        { scope: "/proj", readOnly: true },
      ]);
      assert.equal(r.ok, true, r.error);
      const o = r.value.result;
      console.log(`# tool isolate probe (${transport}): ${JSON.stringify(o)}`);
      assert.deepEqual(o.list, ["readme.md", "src"]);
      assert.match(o.readme, /# proj/);
      assert.match(o.write, /EACCES/);
      assert.match(o.p1, /EACCES/);
      assert.equal(o.attenuate, "refused", "the tool can use the capability, not re-delegate it");
      assert.equal(o.fetch, "blocked");
      assert.equal((await files(ws))["/proj/tool.txt"], undefined);

      // The isolate must have no file system of the host. workerd gives each isolate its own
      // virtual one (/bundle, /tmp, /dev); cellb on Node runs loaded code in a worker thread
      // that resolves the real node:fs (KNOWN GAP, see README).
      const hostFs =
        Array.isArray(o.nodeFsRoot) &&
        o.nodeFsRoot.some((e) => !["bundle", "tmp", "dev"].includes(e));
      if (hostFs && /Node\.js/.test(rt.userAgent)) {
        t.todo(
          `KNOWN GAP (cellb on Node): tool isolate sees the host file system: ${o.nodeFsRoot.slice(0, 6).join(",")}…`,
        );
      } else assert.equal(hostFs, false, `tool isolate sees host files: ${o.nodeFsRoot}`);
    });
  });
}
