// PROTOTYPE test servers: a scripted model, a remote MCP server, a REST API; and the project on
// cellb, loaded in this process from a copy of wrangler.jsonc whose vars point at them.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProject } from "@statewalker/cellb/node";

const listen = (server) =>
  new Promise((ok) =>
    server.listen(0, "127.0.0.1", () => ok(`http://127.0.0.1:${server.address().port}`)),
  );
const readBody = async (req) => {
  let b = "";
  for await (const c of req) b += c;
  return b;
};

/**
 * An OpenAI-compatible chat endpoint (streaming). The last user message drives it:
 *   CALL <tool> <json args>   → one tool call, then "RESULT: <tool output>"
 *   anything else             → "OK"
 * It records the tool names it was offered on every request.
 */
export async function fakeModel() {
  const requests = [];
  const server = createServer(async (req, res) => {
    const json = JSON.parse((await readBody(req)) || "{}");
    const messages = json.messages ?? [];
    requests.push({ tools: (json.tools ?? []).map((t) => t.function?.name) });
    const text = (c) => (typeof c === "string" ? c : (c ?? []).map((p) => p.text ?? "").join(""));
    const user = text([...messages].reverse().find((m) => m.role === "user")?.content).trim();
    const chunk = (delta, finish = null) =>
      `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 0, model: json.model, choices: [{ index: 0, delta, finish_reason: finish }], ...(finish ? { usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } } : {}) })}\n\n`;
    let out;
    const m = /^CALL\s+(\S+)\s*([\s\S]*)$/.exec(user);
    if (messages.at(-1)?.role === "tool") {
      const results = [];
      for (let i = messages.length - 1; i >= 0 && messages[i].role === "tool"; i--)
        results.unshift(text(messages[i].content));
      out = [
        chunk({ role: "assistant", content: `RESULT: ${results.join(" | ")}` }),
        chunk({}, "stop"),
      ];
    } else if (m) {
      out = [
        chunk({
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: `call_${requests.length}`,
              type: "function",
              function: { name: m[1], arguments: m[2] || "{}" },
            },
          ],
        }),
        chunk({}, "tool_calls"),
      ];
    } else out = [chunk({ role: "assistant", content: "OK" }), chunk({}, "stop")];
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (const c of out) res.write(c);
    res.end("data: [DONE]\n\n");
  });
  return { url: `${await listen(server)}/v1`, requests, close: () => server.close() };
}

/** A remote MCP server (Streamable HTTP, JSON responses) with two GitHub-like tools. */
export async function fakeMcp() {
  const calls = [];
  const server = createServer(async (req, res) => {
    const msg = JSON.parse(await readBody(req));
    const reply = (result) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
    };
    if (msg.method === "tools/list")
      return reply({
        tools: [
          {
            name: "search_issues",
            title: "Search issues",
            description: "Search issues in a repository.",
            inputSchema: {
              type: "object",
              properties: { repo: { type: "string" }, q: { type: "string" } },
              required: ["repo", "q"],
            },
            annotations: { readOnlyHint: true, openWorldHint: true },
          },
          {
            name: "create_issue",
            description: "Open an issue.",
            inputSchema: {
              type: "object",
              properties: { repo: { type: "string" }, title: { type: "string" } },
              required: ["repo", "title"],
            },
            annotations: { readOnlyHint: false, openWorldHint: true },
          },
        ],
      });
    if (msg.method === "tools/call") {
      calls.push(msg.params);
      return reply({ content: [{ type: "text", text: `${msg.params.name} ok` }], isError: false });
    }
    reply({});
  });
  return { url: await listen(server), calls, close: () => server.close() };
}

/** A REST API: GET /forecast/{city}?days=, X-Units header, X-Api-Key auth; POST /stations/bulk. */
export async function fakeWeather() {
  const requests = [];
  const server = createServer(async (req, res) => {
    const body = await readBody(req);
    requests.push({
      method: req.method,
      url: req.url,
      units: req.headers["x-units"],
      key: req.headers["x-api-key"],
      body,
    });
    if (req.headers["x-api-key"] !== "wk-secret") return res.writeHead(401).end("no key");
    if (req.url.startsWith("/forecast/nowhere")) return res.writeHead(404).end("unknown city");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify(
        req.url.startsWith("/forecast/")
          ? { temps: [11, 12, 9] }
          : { added: JSON.parse(body || "[]").length },
      ),
    );
  });
  return { url: await listen(server), requests, close: () => server.close() };
}

/** The project on cellb, its vars pointing at the servers. */
export async function startProject(vars) {
  const dir = fileURLToPath(new URL("..", import.meta.url));
  const config = JSON.parse(
    readFileSync(join(dir, "wrangler.jsonc"), "utf8").replace(/^\s*\/\/.*$/gm, ""),
  );
  config.vars = { ...config.vars, ...vars };
  config.main = join(dir, config.main);
  const tmp = mkdtempSync(join(tmpdir(), "harness-proto-tools-"));
  writeFileSync(join(tmp, "wrangler.json"), JSON.stringify(config));
  const project = await loadProject(tmp, { data: join(tmp, "data") });
  const call = async (method, path, body, headers = {}) => {
    const res = await project.fetch(
      new Request(`http://localhost${path}`, {
        method,
        headers: { "content-type": "application/json", ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
    return { status: res.status, body: await res.json() };
  };
  return {
    call,
    admin: (path, body) => call("POST", path, body, { authorization: "Bearer dev-admin-key" }),
    close: async () => {
      await project.close();
      rmSync(tmp, { recursive: true, force: true });
    },
  };
}
