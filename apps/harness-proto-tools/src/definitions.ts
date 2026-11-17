// PROTOTYPE (statewalker/statewalker-root#90). The definitions module's tool half:
//   catalog FilesApi  →  one OpenAPI 3.1 document per tool, in a restricted profile
//                     →  narrowed by the user's role, the agent's request and the mode.
// It knows nothing of cores or DOs; projections live in projections.ts, execution in tools.ts.
//
// The restricted profile (decision (g)): exactly one operation, `POST /tools/<plugin>/<tool>`,
// whose JSON object request body IS the input schema and whose 200 JSON response IS the output
// schema. Everything else (source, action, permission, how to reach the real tool) rides in the
// `x-dev.cellb.harness` extension. An existing REST spec or an MCP server's tools are converted
// into this profile once, when they are read.

import type { FilesApi } from "@statewalker/webrun-files";
import { readText } from "@statewalker/webrun-files";

export const NS = "x-dev.cellb.harness";

export type Action = "read" | "write" | "admin";
export type Source = "native" | "harness" | "mcp" | "rest";

/** How the harness reaches the real tool. Never shown to the model. */
export type Route =
  | { kind: "native"; entry: string }
  | { kind: "harness"; entry: string }
  | { kind: "mcp"; url: string; name: string }
  | {
      kind: "rest";
      method: string;
      url: string; // base + path template
      params: { name: string; in: "path" | "query" | "header" }[];
      body?: "object" | "wrapped"; // the body's properties, or one "body" property
      auth?: { header: string; secretVar: string };
    };

export interface Extension {
  id: string; // <plugin>/<tool>
  name: string; // the projected name: <plugin>__<tool>, [A-Za-z0-9_-], at most 64
  source: Source;
  plugin: string;
  tool: string;
  action: Action;
  permission: string;
  route: Route;
  /** Where the profile bent the original (decision record for the prototype's readers). */
  notes: string[];
}

export type JsonSchema = Record<string, unknown>;

export interface ToolDefinition {
  openapi: "3.1.0";
  info: { title: string; version: string; description: string };
  paths: Record<string, { post: Record<string, unknown> }>;
  components?: { schemas?: Record<string, JsonSchema> };
  [NS]: Extension;
}

// ---- names (decision (h)) ---------------------------------------------------------------------

/** `<plugin>__<tool>`, cut to MCP's and the providers' charset; over 64, cut and hashed. */
export function projectedName(plugin: string, tool: string): string {
  const raw = `${plugin}__${tool}`.replace(/[^A-Za-z0-9_-]/g, "_");
  if (raw.length <= 64) return raw;
  let h = 0;
  for (const c of raw) h = (Math.imul(h, 31) + c.charCodeAt(0)) | 0;
  return `${raw.slice(0, 55)}_${(h >>> 0).toString(16).padStart(8, "0")}`;
}

// ---- schemas (decision (h)): strict-mode friendly -----------------------------------------------

/** Every object schema closed (`additionalProperties: false`), recursively. */
export function closed(schema: JsonSchema | undefined): JsonSchema {
  const walk = (s: unknown): unknown => {
    if (Array.isArray(s)) return s.map(walk);
    if (!s || typeof s !== "object") return s;
    const o: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(s)) o[k] = walk(v);
    if (o.type === "object" && o.additionalProperties === undefined) o.additionalProperties = false;
    return o;
  };
  return walk(schema ?? { type: "object", properties: {} }) as JsonSchema;
}

/** `$ref: #/components/schemas/X` replaced by X (projections need self-contained schemas). */
export function inlined(schema: unknown, schemas: Record<string, JsonSchema> = {}): JsonSchema {
  const walk = (s: unknown, depth: number): unknown => {
    if (depth > 20) return {};
    if (Array.isArray(s)) return s.map((x) => walk(x, depth + 1));
    if (!s || typeof s !== "object") return s;
    const ref = (s as { $ref?: string }).$ref;
    if (typeof ref === "string") return walk(schemas[ref.split("/").pop() ?? ""] ?? {}, depth + 1);
    return Object.fromEntries(Object.entries(s).map(([k, v]) => [k, walk(v, depth + 1)]));
  };
  return walk(schema, 0) as JsonSchema;
}

// ---- the profile ------------------------------------------------------------------------------

function profile(p: {
  plugin: string;
  tool: string;
  source: Source;
  description: string;
  action: Action;
  input: JsonSchema;
  output?: JsonSchema;
  schemas?: Record<string, JsonSchema>;
  permission?: string;
  route: Route;
  notes?: string[];
}): ToolDefinition {
  const id = `${p.plugin}/${p.tool}`;
  return {
    openapi: "3.1.0",
    info: { title: id, version: "1", description: p.description },
    paths: {
      [`/tools/${id}`]: {
        post: {
          operationId: projectedName(p.plugin, p.tool),
          summary: p.description,
          requestBody: {
            required: true,
            content: { "application/json": { schema: closed(p.input) } },
          },
          responses: {
            200: {
              description: "Result",
              content: { "application/json": { schema: p.output ?? {} } },
            },
            default: { description: "The tool failed, or the call was refused" },
          },
        },
      },
    },
    ...(p.schemas ? { components: { schemas: p.schemas } } : {}),
    [NS]: {
      id,
      name: projectedName(p.plugin, p.tool),
      source: p.source,
      plugin: p.plugin,
      tool: p.tool,
      action: p.action,
      permission: p.permission ?? `tools.use:${id}`,
      route: p.route,
      notes: p.notes ?? [],
    },
  };
}

export const opOf = (d: ToolDefinition) =>
  Object.values(d.paths)[0]?.post as {
    requestBody: { content: { "application/json": { schema: JsonSchema } } };
    responses: { 200: { content: { "application/json": { schema: JsonSchema } } } };
  };
export const inputOf = (d: ToolDefinition) =>
  inlined(opOf(d).requestBody.content["application/json"].schema, d.components?.schemas);
export const outputOf = (d: ToolDefinition) => {
  const s = opOf(d).responses[200].content["application/json"].schema;
  return s && Object.keys(s).length ? inlined(s, d.components?.schemas) : undefined;
};

// ---- sources ------------------------------------------------------------------------------------

/** Harness tools: built in, the only way into a project's system folder. */
export const HARNESS_TOOLS: ToolDefinition[] = [
  profile({
    plugin: "harness",
    tool: "members.list",
    source: "harness",
    description: "List the project's members and their roles.",
    action: "read",
    permission: "members.read",
    input: { type: "object", properties: {} },
    output: { type: "object", properties: { members: { type: "object" } } },
    route: { kind: "harness", entry: "members.list" },
  }),
  profile({
    plugin: "harness",
    tool: "members.add",
    source: "harness",
    description: "Give a user a role in the project.",
    action: "admin",
    permission: "members.write",
    input: {
      type: "object",
      properties: { user: { type: "string" }, role: { enum: ["reader", "editor", "owner"] } },
      required: ["user", "role"],
    },
    route: { kind: "harness", entry: "members.add" },
  }),
];

async function* dirs(files: FilesApi, path: string) {
  for await (const e of files.list(path)) if (e.kind === "directory") yield e.name;
}
async function* jsonFiles(files: FilesApi, path: string) {
  try {
    for await (const e of files.list(path))
      if (e.kind === "file" && e.name.endsWith(".json")) yield e.name;
  } catch {
    // no such folder
  }
}
const tryJson = async (files: FilesApi, path: string) => {
  try {
    return JSON.parse(await readText(files, path));
  } catch {
    return undefined;
  }
};
const fill = (s: string, vars: Record<string, string | undefined>) =>
  s.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? "");

/** An MCP server's `tools/list`, over Streamable HTTP (JSON responses). */
export async function mcpRequest(url: string, method: string, params: unknown, id = 1) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  const body = (await res.json()) as { result?: unknown; error?: { message: string } };
  if (body.error) throw new Error(`MCP ${method}: ${body.error.message}`);
  return body.result as Record<string, unknown>;
}

function fromMcp(plugin: string, url: string, t: Record<string, unknown>): ToolDefinition {
  const a = (t.annotations ?? {}) as Record<string, boolean>;
  const notes = ["annotations kept as hints only; the server's own permission decides"];
  if (!t.outputSchema) notes.push("no outputSchema: the result is untyped content");
  return profile({
    plugin,
    tool: String(t.name),
    source: "mcp",
    description: String(t.description ?? t.title ?? t.name),
    action: a.readOnlyHint ? "read" : a.destructiveHint ? "admin" : "write",
    input: (t.inputSchema as JsonSchema) ?? { type: "object", properties: {} },
    output: t.outputSchema as JsonSchema | undefined,
    route: { kind: "mcp", url, name: String(t.name) },
    notes,
  });
}

type Op = {
  operationId: string;
  summary?: string;
  parameters?: { name: string; in: string; required?: boolean; schema?: JsonSchema }[];
  requestBody?: { content?: Record<string, { schema?: JsonSchema }> };
  responses?: Record<string, { content?: Record<string, { schema?: JsonSchema }> }>;
};

function fromRest(
  plugin: string,
  spec: Record<string, unknown>,
  vars: Record<string, string | undefined>,
) {
  const base = fill(String((spec.servers as { url: string }[])?.[0]?.url ?? ""), vars);
  const schemes = ((spec.components as Record<string, unknown>)?.securitySchemes ?? {}) as Record<
    string,
    { type: string; in: string; name: string }
  >;
  const scheme = Object.values(schemes).find((s) => s.type === "apiKey" && s.in === "header");
  const out: ToolDefinition[] = [];
  for (const [path, item] of Object.entries(
    (spec.paths ?? {}) as Record<string, Record<string, Op>>,
  )) {
    for (const [method, op] of Object.entries(item)) {
      const notes: string[] = [];
      const props: Record<string, JsonSchema> = {};
      const required: string[] = [];
      const params = (op.parameters ?? []).filter((p) => p.in !== "cookie");
      for (const p of params) {
        props[p.name] = { ...(p.schema ?? {}), description: `${p.in} parameter` };
        if (p.required) required.push(p.name);
      }
      if (params.length)
        notes.push(
          `parameters flattened into one object (${params.map((p) => `${p.name} in ${p.in}`).join(", ")}); the route puts them back`,
        );
      let body: "object" | "wrapped" | undefined;
      const json = op.requestBody?.content?.["application/json"]?.schema;
      if (json?.type === "object") {
        Object.assign(props, json.properties ?? {});
        body = "object";
      } else if (json) {
        props.body = json;
        required.push("body");
        body = "wrapped";
        notes.push(
          `a ${String(json.type)} body can't be the input object: it is the "body" property`,
        );
      }
      if (op.requestBody?.content?.["multipart/form-data"])
        notes.push("multipart body has no JSON form: not imported");
      const ok = Object.entries(op.responses ?? {}).find(([c]) => c.startsWith("2"));
      const errors = Object.keys(op.responses ?? {}).filter((c) => !c.startsWith("2"));
      if (errors.length) notes.push(`${errors.join(", ")} become an error result`);
      if (scheme) notes.push("the auth scheme is hidden from the model; the harness adds the key");
      if (op.requestBody?.content?.["multipart/form-data"]) continue;
      out.push(
        profile({
          plugin,
          tool: op.operationId,
          source: "rest",
          description: op.summary ?? op.operationId,
          action: method === "get" || method === "head" ? "read" : "write",
          input: { type: "object", properties: props, ...(required.length ? { required } : {}) },
          output: ok?.[1]?.content?.["application/json"]?.schema,
          route: {
            kind: "rest",
            method: method.toUpperCase(),
            url: base + path,
            params: params.map((p) => ({ name: p.name, in: p.in as "path" | "query" | "header" })),
            body,
            ...(scheme
              ? { auth: { header: scheme.name, secretVar: `${plugin.toUpperCase()}_API_KEY` } }
              : {}),
          },
          notes,
        }),
      );
    }
  }
  return out;
}

/** Every tool the catalog offers, as tool definitions (before any narrowing). */
export async function readCatalog(
  files: FilesApi,
  vars: Record<string, string | undefined>,
): Promise<ToolDefinition[]> {
  const defs: ToolDefinition[] = [...HARNESS_TOOLS];
  for await (const plugin of dirs(files, "/")) {
    for await (const f of jsonFiles(files, `/${plugin}/tools`)) {
      const t = await tryJson(files, `/${plugin}/tools/${f}`);
      if (!t) continue;
      defs.push(
        profile({
          plugin,
          tool: f.replace(/\.json$/, ""),
          source: "native",
          description: t.description,
          action: t.action,
          input: t.input,
          output: t.output,
          schemas: t.components,
          route: { kind: "native", entry: t.entry },
          notes: t.components ? ["$ref kept here; inlined in the projections"] : [],
        }),
      );
    }
    const mcp = await tryJson(files, `/${plugin}/mcp.json`);
    for (const server of Object.values(
      (mcp?.mcpServers ?? {}) as Record<string, { url: string }>,
    )) {
      const url = fill(server.url, vars);
      const listed = await mcpRequest(url, "tools/list", {});
      for (const t of (listed.tools ?? []) as Record<string, unknown>[])
        defs.push(fromMcp(plugin, url, t));
    }
    const spec = await tryJson(files, `/${plugin}/openapi.json`);
    if (spec) defs.push(...fromRest(plugin, spec, vars));
  }
  return defs;
}

/** An agent's requested tools, from its AGENT.md front matter (`tools: [a, b]`). */
export async function agentRequests(files: FilesApi, agent: string): Promise<string[]> {
  for await (const plugin of dirs(files, "/")) {
    let md: string | undefined;
    try {
      md = await readText(files, `/${plugin}/agents/${agent}/AGENT.md`);
    } catch {
      continue;
    }
    const m = /^tools:\s*\[([^\]]*)\]/m.exec(md);
    return (m?.[1] ?? "")
      .split(",")
      .map((s) => s.trim().replace(/^['"]|['"]$/g, ""))
      .filter(Boolean);
  }
  throw new Error(`ENOENT: no agent '${agent}' in the catalog`);
}

// ---- narrowing ----------------------------------------------------------------------------------

/** What each built-in role grants (#77, #80): `*.use` permissions plus the harness's own. */
export const ROLE_PERMISSIONS: Record<string, string[]> = {
  reader: [
    "tools.use:todo/list",
    "tools.use:github/search_issues",
    "tools.use:weather/forecast",
    "members.read",
  ],
  editor: ["tools.use:todo/*", "tools.use:github/*", "tools.use:weather/*", "members.read"],
  owner: ["tools.use:*", "members.read", "members.write"],
};

/** Mode rules per action kind (#79). */
export const MODES: Record<string, Record<Action, "allow" | "ask" | "deny">> = {
  default: { read: "allow", write: "ask", admin: "ask" },
  acceptEdits: { read: "allow", write: "allow", admin: "ask" },
  plan: { read: "allow", write: "deny", admin: "deny" },
  dontAsk: { read: "allow", write: "deny", admin: "deny" },
  bypassPermissions: { read: "allow", write: "allow", admin: "allow" },
};

const matches = (pattern: string, value: string) =>
  pattern === value ||
  pattern === "*" ||
  (pattern.endsWith("*") && value.startsWith(pattern.slice(0, -1)));

export interface Offered {
  def: ToolDefinition;
  decision: "allow" | "ask";
}
export interface Narrowed {
  offered: Offered[];
  absent: { id: string; why: string }[];
}

/**
 * The agent session's tool set: requested by the agent AND granted by the role AND not denied
 * by the mode (decision (c): a denied tool is not offered at all; an asking one is offered).
 */
export function narrow(
  defs: ToolDefinition[],
  ctx: { role: string; requests: string[]; mode: string },
): Narrowed {
  const perms = ROLE_PERMISSIONS[ctx.role] ?? [];
  const rules = MODES[ctx.mode];
  if (!rules) throw new Error(`EINVAL: unknown mode '${ctx.mode}'`);
  const offered: Offered[] = [];
  const absent: { id: string; why: string }[] = [];
  for (const def of defs) {
    const x = def[NS];
    if (!ctx.requests.some((p) => matches(p, x.id)))
      absent.push({ id: x.id, why: "not requested by the agent" });
    else if (!perms.some((p) => matches(p, x.permission)))
      absent.push({ id: x.id, why: `the ${ctx.role} role lacks ${x.permission}` });
    else if (rules[x.action] === "deny")
      absent.push({ id: x.id, why: `mode ${ctx.mode} denies ${x.action} tools` });
    else offered.push({ def, decision: rules[x.action] as "allow" | "ask" });
  }
  return { offered, absent };
}
