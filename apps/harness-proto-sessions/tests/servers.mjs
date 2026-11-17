// PROTOTYPE test servers: a scripted model; and the project on
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
 *   READ <path> · WRITE <path> <text> · BASH <command>   → shortcuts for Flue's tools
 *   SLOW <ms> <command>       → waits, then does <command> (a long turn)
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
    let cmd = user;
    const slow = /^SLOW\s+(\d+)\s+([\s\S]*)$/.exec(cmd);
    if (slow && messages.at(-1)?.role !== "tool") {
      await new Promise((r) => setTimeout(r, Number(slow[1])));
      cmd = slow[2];
    }
    const short = /^(READ|WRITE|BASH)\s+(\S+)(?:\s+([\s\S]*))?$/.exec(cmd);
    if (short) {
      const [, verb, a, b] = short;
      cmd =
        verb === "READ"
          ? `CALL read ${JSON.stringify({ path: a })}`
          : verb === "WRITE"
            ? `CALL write ${JSON.stringify({ path: a, content: b ?? "" })}`
            : `CALL bash ${JSON.stringify({ command: `${a} ${b ?? ""}`.trim() })}`;
    }
    const m = /^CALL\s+(\S+)\s*([\s\S]*)$/.exec(cmd);
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

/** The project on cellb, its vars pointing at the servers. */
export async function startProject(vars) {
  const dir = fileURLToPath(new URL("..", import.meta.url));
  const config = JSON.parse(
    readFileSync(join(dir, "wrangler.jsonc"), "utf8").replace(/^\s*\/\/.*$/gm, ""),
  );
  config.vars = { ...config.vars, ...vars };
  config.main = join(dir, config.main);
  const tmp = mkdtempSync(join(tmpdir(), "harness-proto-sessions-"));
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
