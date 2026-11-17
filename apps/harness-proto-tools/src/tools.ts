// PROTOTYPE (statewalker/statewalker-root#90). Running a tool from its definition's route.
//   native  → a function of the plugin, given ONLY the session's file capability
//   harness → a method of the Workspace cell (owner side: the system folder lives there)
//   mcp     → `tools/call` on the remote server, from this cell (the host-side gateway, #73)
//   rest    → the HTTP request the route rebuilds (path, query, header, body; key added here)
//
// Native tools are plain functions here: bundling them and running them in a Worker Loader
// isolate is flue-capfs-do's part, already proven there.

import { CapFs } from "../../flue-capfs-do/src/capfs.ts";
import type { Cap } from "../../flue-capfs-do/src/caps.ts";
import { mcpRequest, NS, type ToolDefinition } from "./definitions.ts";
import type { ToolResult } from "./projections.ts";

export interface ToolContext {
  cap: Cap;
  cwd: string; // the session's project, e.g. /alpha
  project: string;
  token: string;
  harness: (entry: string, project: string, token: string, args: unknown) => Promise<unknown>;
  secrets: Record<string, string | undefined>;
}

const NATIVE: Record<
  string,
  (ctx: ToolContext, args: Record<string, unknown>) => Promise<unknown>
> = {
  async "todo.add"(ctx, args) {
    const fs = new CapFs(ctx.cap);
    const file = `${ctx.cwd}/todo.md`;
    const before = (await fs.exists(file)) ? await fs.readFile(file) : "";
    const line = `- [ ] ${String(args.text)}${args.due ? ` (due ${String(args.due)})` : ""}\n`;
    await fs.writeFile(file, before + line);
    return { line: before.split("\n").filter(Boolean).length + 1 };
  },
  async "todo.list"(ctx) {
    const fs = new CapFs(ctx.cap);
    const file = `${ctx.cwd}/todo.md`;
    const text = (await fs.exists(file)) ? await fs.readFile(file) : "";
    return {
      items: text
        .split("\n")
        .filter(Boolean)
        .map((t) => ({ text: t })),
    };
  },
  /** A native tool that tries to step outside the project: the capability must refuse it. */
  async "todo.peek"(ctx, args) {
    return { text: await new CapFs(ctx.cap).readFile(String(args.path)) };
  },
};

const ok = (value: unknown): ToolResult => ({
  content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }],
  details: value,
  structuredContent: value,
});
export const failed = (message: string): ToolResult => ({
  content: [{ type: "text", text: message }],
  details: { error: message },
  isError: true,
});

export async function runTool(
  def: ToolDefinition,
  args: unknown,
  ctx: ToolContext,
): Promise<ToolResult> {
  const route = def[NS].route;
  const a = (args ?? {}) as Record<string, unknown>;
  try {
    switch (route.kind) {
      case "native": {
        const fn = NATIVE[route.entry];
        if (!fn) return failed(`no native entry '${route.entry}'`);
        return ok(await fn(ctx, a));
      }
      case "harness":
        return ok(await ctx.harness(route.entry, ctx.project, ctx.token, a));
      case "mcp": {
        const r = await mcpRequest(route.url, "tools/call", { name: route.name, arguments: a });
        const text = ((r.content ?? []) as { text?: string }[]).map((c) => c.text ?? "").join("\n");
        return { ...ok(r.structuredContent ?? text), isError: r.isError === true };
      }
      case "rest": {
        let path = route.url;
        const query = new URLSearchParams();
        const headers: Record<string, string> = {};
        for (const p of route.params) {
          const v = a[p.name];
          if (v === undefined) continue;
          if (p.in === "path") path = path.replace(`{${p.name}}`, encodeURIComponent(String(v)));
          else if (p.in === "query") query.set(p.name, String(v));
          else headers[p.name] = String(v);
        }
        if (route.auth) headers[route.auth.header] = ctx.secrets[route.auth.secretVar] ?? "";
        let body: string | undefined;
        if (route.body === "wrapped") body = JSON.stringify(a.body);
        else if (route.body === "object") {
          const named = new Set(route.params.map((p) => p.name));
          body = JSON.stringify(
            Object.fromEntries(Object.entries(a).filter(([k]) => !named.has(k))),
          );
        }
        if (body) headers["content-type"] = "application/json";
        const qs = query.toString();
        const res = await fetch(qs ? `${path}?${qs}` : path, {
          method: route.method,
          headers,
          body,
        });
        const text = await res.text();
        if (!res.ok) return failed(`HTTP ${res.status}: ${text}`);
        try {
          return ok(JSON.parse(text));
        } catch {
          return ok(text);
        }
      }
    }
  } catch (e) {
    return failed(String((e as Error)?.message ?? e));
  }
}
