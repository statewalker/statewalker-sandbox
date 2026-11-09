// Python execution on the capability file system: one set of cases, run against every runtime
// that serves this project. `api(path, body?, { admin })` → { status, ok, value | code, error }:
// over HTTP for Node runtimes (tests/python.test.mjs), through the page for the browser
// (tests/browser.test.mjs).
import assert from "node:assert/strict";

const SEED = {
  "/proj/data.csv": "a,b\n1,2\n3,4\n",
  "/proj/lib/helper.py": "def double(x):\n    return 2 * x\n",
  "/proj/sub/notes.md": "# notes\n",
  "/hr/salaries.csv": "alice,100\n",
};

let n = 0;
export function pythonCases({ api, transports = ["stub", "token"], label = "" }) {
  const RUN = `${label}${Date.now().toString(36)}`;
  const freshWs = () => `py-${RUN}-${++n}`;
  const admin = async (path, body) => {
    const r = await api(path, body, { admin: true });
    assert.equal(r.ok, true, `${path}: ${r.error}`);
    return r.value;
  };
  const setup = async (rights = ["/proj"], mode) => {
    const ws = freshWs();
    await admin(`/api/w/${ws}/seed`, { files: SEED });
    const s = await admin(`/api/w/${ws}/sessions`, { user: "alice", rights, mode });
    return { ws, ...s };
  };
  const files = (ws) => admin(`/api/w/${ws}/files`);
  const py = (ws, token, transport, task, chain = []) =>
    api(`/api/agents/py-${ws}/run`, {
      workspace: ws,
      token,
      transport,
      chain,
      task: { kind: "python", ...task },
    });
  const ok = (r) => {
    assert.equal(r.ok, true, r.error);
    return r.value.result;
  };

  const cases = [];
  const add = (name, fn) => cases.push({ name, fn });

  for (const transport of transports) {
    add(
      `[${transport}] /workspace holds what the capability can read; changes are written back through it`,
      async () => {
        const { ws, token } = await setup();
        const r = ok(
          await py(ws, token, transport, {
            code: `import os, csv, sys
sys.path.insert(0, "/workspace/proj/lib")
from helper import double
print(sorted(os.listdir("/workspace")), os.getcwd())
rows = list(csv.reader(open("/workspace/proj/data.csv")))
open("/workspace/proj/total.txt", "w").write(str(double(sum(int(r[0]) for r in rows[1:]))))
os.remove("/workspace/proj/sub/notes.md")
os.makedirs("/workspace/hr", exist_ok=True)
open("/workspace/hr/stolen.txt", "w").write("x")
len(rows)`,
          }),
        );
        assert.equal(r.error, undefined, r.error);
        assert.match(r.stdout, /^\['proj'\] \/workspace/);
        assert.equal(r.value, 3);
        assert.equal(r.synced.files, 3);
        assert.deepEqual(r.written, ["/proj/total.txt"]);
        assert.deepEqual(r.deleted, ["/proj/sub/notes.md"]);
        assert.deepEqual(
          r.denied.map((d) => [d.path, d.op, d.error.split(":")[0]]),
          [
            ["/hr", "mkdir", "EACCES"],
            ["/hr/stolen.txt", "write", "EACCES"],
          ],
        );
        const all = await files(ws);
        assert.equal(all["/proj/total.txt"], "8");
        assert.equal(all["/proj/sub/notes.md"], undefined);
        assert.equal(all["/hr/stolen.txt"], undefined);
        assert.equal(all["/hr/salaries.csv"], "alice,100\n");
      },
    );

    add(
      `[${transport}] the live capfs module calls the capability (and is refused outside it)`,
      async () => {
        const { ws, token } = await setup();
        const r = ok(
          await py(ws, token, transport, {
            code: `import capfs
await capfs.write_text("/proj/live.txt", "written live")
names = sorted(await capfs.listdir("/proj"))
text = await capfs.read_text("/workspace/proj/live.txt")
try:
    await capfs.read_text("/hr/salaries.csv")
    denied = "read"
except Exception as e:
    denied = str(e)
f"{names}|{text}|{denied}"`,
          }),
        );
        assert.equal(r.error, undefined, r.error);
        const [names, text, denied] = String(r.value).split("|");
        assert.equal(names, "['data.csv', 'lib', 'live.txt', 'sub']");
        assert.equal(text, "written live");
        assert.match(denied, /EACCES/);
        assert.equal((await files(ws))["/proj/live.txt"], "written live");
      },
    );

    add(
      `[${transport}] a delegated read-only scope: only that subtree, and no write gets through`,
      async () => {
        const { ws, token } = await setup(["/proj"]);
        const r = ok(
          await py(
            ws,
            token,
            transport,
            {
              code: `import os
w = [os.path.join(d, f) for d, _, fs in os.walk("/workspace") for f in fs]
open("/workspace/proj/sub/new.md", "w").write("x")
sorted(w)`,
            },
            [{ scope: "/proj/sub", readOnly: true }],
          ),
        );
        assert.equal(r.value, "['/workspace/proj/sub/notes.md']");
        assert.deepEqual(r.written, []);
        assert.deepEqual(
          r.denied.map((d) => d.path),
          ["/proj/sub/new.md"],
        );
      },
    );
  }

  add("the engine is isolated: no host files, no JS globals, no code generation", async () => {
    const { ws, token } = await setup();
    const r = ok(
      await py(ws, token, "stub", {
        code: `import js, pyodide_js
out = []
try:
    open("/etc/passwd").read(); out.append("host-file")
except Exception as e:
    out.append(type(e).__name__)
out.append("js:" + ",".join(n for n in dir(js) if not n.startswith("_"))[:40])
try:
    pyodide_js.loadPackage.constructor("return 1")(); out.append("eval-ran")
except Exception as e:
    out.append("eval-blocked")
"|".join(out)`,
      }),
    );
    const [hostFile, js, evalResult] = String(r.value).split("|");
    assert.equal(hostFile, "FileNotFoundError");
    assert.doesNotMatch(js, /fetch|process|navigator|location|self/);
    assert.equal(evalResult, "eval-blocked");
  });

  add("each run starts clean: fresh globals and modules, a fresh /workspace", async () => {
    const { ws, token } = await setup();
    ok(
      await py(ws, token, "stub", {
        code: "import sys\nsys.path.insert(0, '/workspace/proj/lib')\nimport helper\nx = 41\nopen('/tmp/scratch', 'w').write('1')",
      }),
    );
    const r = ok(
      await py(ws, token, "stub", {
        code: `import sys, os
r = []
try:
    x; r.append("x-leaked")
except NameError:
    r.append("x-fresh")
r.append("helper-leaked" if "helper" in sys.modules else "modules-fresh")
r.append("|".join(sorted(os.listdir("/workspace"))))
"/".join(r)`,
      }),
    );
    assert.equal(r.value, "x-fresh/modules-fresh/proj");
  });

  add("binary output is refused; a runaway run times out and the next run works", async () => {
    const { ws, token } = await setup();
    const bin = ok(
      await py(ws, token, "stub", {
        code: "open('/workspace/proj/x.bin', 'wb').write(bytes([255, 254]))",
      }),
    );
    assert.deepEqual(
      bin.denied.map((d) => [d.path, d.error.split(":")[0]]),
      [["/proj/x.bin", "EINVAL"]],
    );
    const slow = await py(ws, token, "stub", { code: "while True:\n    pass", timeoutMs: 1500 });
    assert.equal(slow.ok, false);
    assert.equal(slow.code, "ETIMEDOUT");
    const after = ok(await py(ws, token, "stub", { code: "1 + 1" }));
    assert.equal(after.value, 2);
  });

  return cases;
}
