// A fake OpenAI-compatible chat-completions endpoint (streaming), so the `agent` task is tested
// through pi-ai's real provider code without a model or a key. It follows commands in the last
// user message, one tool call per turn:
//   READ <path> / WRITE <path> <text> / BASH <command>  → a tool call, then "RESULT: <tool output>"
//   LOOP                                                 → a tool call every turn (never stops)
//   HISTORY                                              → "MESSAGES: <n>" (messages it was sent)
//   anything else                                        → "OK"
// It answers browsers too (CORS), and records each request.
import { createServer } from "node:http";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "*",
  "access-control-allow-methods": "POST, OPTIONS",
};

export function startFakeLlm(port = 0) {
  const requests = [];
  const server = createServer(async (req, res) => {
    if (req.method === "OPTIONS") return res.writeHead(204, CORS).end();
    let body = "";
    for await (const c of req) body += c;
    const json = JSON.parse(body || "{}");
    requests.push({
      url: req.url,
      auth: req.headers.authorization,
      model: json.model,
      tools: (json.tools ?? []).map((t) => t.function?.name),
    });
    const messages = json.messages ?? [];
    const last = messages.at(-1);
    const content = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
    // OpenAI content is a string or a list of parts ({ type: "text", text }).
    const text = (
      typeof content === "string" ? content : content.map((p) => p.text ?? "").join("")
    ).trim();
    const chunk = (delta, finish = null) =>
      `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 0, model: json.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    const toolCall = (name, args) => [
      chunk({
        role: "assistant",
        tool_calls: [
          {
            index: 0,
            id: `call_${requests.length}`,
            type: "function",
            function: { name, arguments: JSON.stringify(args) },
          },
        ],
      }),
      chunk({}, "tool_calls"),
    ];
    const say = (content) => [chunk({ role: "assistant", content }), chunk({}, "stop")];
    let out;
    const m = text.match(/^(READ|WRITE|BASH)\s+(\S+)(?:\s+([\s\S]*))?$/);
    if (/^LOOP\b/.test(text)) out = toolCall("bash", { command: "echo again" });
    else if (last?.role === "tool") {
      const result =
        typeof last.content === "string"
          ? last.content
          : last.content.map((p) => p.text ?? "").join("");
      out = say(`RESULT: ${result.trim()}`);
    } else if (/^HISTORY\b/.test(text)) out = say(`MESSAGES: ${messages.length}`);
    else if (m?.[1] === "READ") out = toolCall("read", { path: m[2] });
    else if (m?.[1] === "WRITE") out = toolCall("write", { path: m[2], content: m[3] ?? "" });
    else if (m?.[1] === "BASH") out = toolCall("bash", { command: `${m[2]} ${m[3] ?? ""}`.trim() });
    else out = say("OK");
    res.writeHead(200, { "content-type": "text/event-stream", ...CORS });
    for (const c of out) res.write(c);
    res.end("data: [DONE]\n\n");
  });
  return new Promise((ok) =>
    server.listen(port, "127.0.0.1", () => {
      const { port: p } = server.address();
      ok({
        server,
        requests,
        port: p,
        config: { baseUrl: `http://127.0.0.1:${p}/v1`, model: "fake-model" },
      });
    }),
  );
}
