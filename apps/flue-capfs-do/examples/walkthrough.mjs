// A guided tour of the prototype against a running runtime: the README's examples, end to end.
//   pnpm dev:wrangler            # or: pnpm dev:cellb  (then BASE_URL=http://127.0.0.1:8788)
//   node examples/walkthrough.mjs
import { Biscuit } from "@statewalker/webrun-biscuit";

const BASE = process.env.BASE_URL ?? "http://127.0.0.1:8787";
const ADMIN = { authorization: `Bearer ${process.env.ADMIN_KEY ?? "dev-admin-key"}` };
const ws = `acme-${Date.now().toString(36)}`;

async function post(path, body, headers = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!json.ok) throw new Error(`${path}: ${json.error}`);
  return json.value;
}
const admin = (path, body) => post(path, body, ADMIN);
const run = (agent, body) => post(`/api/agents/${agent}/run`, { workspace: ws, ...body });
const step = (title, value) =>
  console.log(
    `\n## ${title}\n${typeof value === "string" ? value : JSON.stringify(value, null, 2)}`,
  );

// 1. The admin imports files and opens a session for alice (rights: /proj and /plans).
await admin(`/api/w/${ws}/seed`, {
  files: {
    "/proj/readme.md": "# Project\nTODO: write the spec\n",
    "/proj/src/main.js": "console.log('hi'); // TODO tests\n",
    "/hr/salaries.csv": "alice,100\nbob,90\n",
  },
});
const { session, token } = await admin(`/api/w/${ws}/sessions`, {
  user: "alice",
  rights: ["/proj", "/plans"],
  mode: "yolo",
});
step("session", { session, token: `${token.slice(0, 24)}…` });

// 2. The agent works through just-bash: /hr does not exist for it.
const sh = (script, extra = {}) =>
  run("alice-1", { token, transport: "stub", task: { kind: "bash", script }, ...extra }).then(
    (r) => r.result,
  );
step(
  "bash: ls / ; grep -r TODO /proj ; cat /hr/salaries.csv",
  await sh("ls /; grep -r TODO /proj; cat /hr/salaries.csv"),
);

// 3. Flue's own tools, called as a model would call them.
const flue = await run("alice-1", {
  token,
  transport: "token",
  task: {
    kind: "flue",
    calls: [
      { tool: "write", params: { path: "/proj/notes.md", content: "first draft\n" } },
      { tool: "edit", params: { path: "/proj/notes.md", oldText: "first", newText: "second" } },
      { tool: "grep", params: { pattern: "TODO", path: "/proj" } },
      { tool: "glob", params: { pattern: "*.md", path: "/proj" } },
      { tool: "read", params: { path: "/hr/salaries.csv" } },
    ],
  },
});
step("flue tools", flue.result);

// 4. The host switches alice to plan mode: /proj becomes read-only, /plans stays writable.
await admin(`/api/w/${ws}/sessions/${session}/mode`, { mode: "plan" });
// (A refused redirect aborts the rest of a just-bash script, so these are two calls.)
step("plan mode: write /proj", await sh("echo x >> /proj/notes.md"));
step("plan mode: write /plans", await sh("echo step 1 >> /plans/plan.md && cat /plans/plan.md"));
await admin(`/api/w/${ws}/sessions/${session}/mode`, { mode: "yolo" });

// 5. Delegation over two hops: /proj only, then read-only.
const delegated = await run("alice-1", {
  token,
  transport: "token",
  chain: [{ scope: "/proj" }, { readOnly: true }],
  task: { kind: "flue", calls: [{ tool: "grep", params: { pattern: "TODO", path: "/proj" } }] },
});
step(`delegated grep (hops: ${delegated.hops.join(" → ")})`, delegated.result);

// 6. Tool code in a Worker Loader isolate, holding only the narrowed capability.
const code = `import { WorkerEntrypoint } from "cloudflare:workers";
export default class extends WorkerEntrypoint {
  async run(files, input) {
    const out = { list: await files.readdir("/proj") };
    try { await files.call("writeFile", "/proj/tool.txt", "x"); out.write = "allowed"; } catch (e) { out.write = e.message; }
    try { await fetch("https://example.com/"); out.fetch = "allowed"; } catch { out.fetch = "blocked"; }
    return out;
  }
}`;
// On cellb (Node) tool isolates could reach the host's files, so the agent refuses them (EPERM).
const tool = await run("alice-1", {
  token,
  transport: "stub",
  chain: [{ scope: "/proj", readOnly: true }],
  task: { kind: "tool", code },
}).then(
  (r) => r.result,
  (e) => e.message,
);
step("tool isolate", tool);

// 7. Alice hands a narrowed token to someone offline, then the admin revokes it.
const child = Biscuit.fromBase64(token)
  .attenuate(`check if operation($o), ["read","list"].contains($o);`)
  .toBase64();
const rid = (
  await run("alice-1", { token: child, transport: "token", task: { kind: "revocationId" } })
).result;
await admin(`/api/w/${ws}/sessions/${session}/revoke`, { rid });
// Flue's read tool reports the denial itself (just-bash's `cat` would say "No such file").
const afterRevoke = await run("alice-1", {
  token: child,
  transport: "token",
  task: { kind: "flue", calls: [{ tool: "read", params: { path: "/proj/readme.md" } }] },
}).then(
  (r) => r.result,
  (e) => e.message,
);
step("revoked child token", afterRevoke);
step("parent token still works", await sh("cat /proj/notes.md"));
