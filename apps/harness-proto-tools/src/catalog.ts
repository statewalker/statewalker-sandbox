// PROTOTYPE. The deployment's catalog, as the files a catalog FilesApi would hold. In a
// deployment the catalog is a configured FilesApi (local, S3, …); here its files are bundled and
// written into a MemFilesApi when a cell starts, so the definitions module reads them through the
// FilesApi interface like it would read any other mount.
//
//   <plugin>/plugin.json                     Agent Plugins manifest
//   <plugin>/tools/<tool>.json               a native tool: schemas, action, entry
//   <plugin>/mcp.json                        a remote MCP server ({{VAR}} filled from env)
//   <plugin>/openapi.json                    an existing REST API's spec, imported
//   <plugin>/agents/<agent>/AGENT.md         an agent; its `tools:` are requests, not grants

const json = (v: unknown) => JSON.stringify(v, null, 2);

export const CATALOG: Record<string, string> = {
  "/todo/plugin.json": json({
    name: "todo",
    version: "1.0.0",
    description: "A todo list in the project",
  }),
  "/todo/tools/add.json": json({
    description: "Add an item to the project's todo list (todo.md in the working directory).",
    action: "write",
    entry: "todo.add",
    input: {
      type: "object",
      properties: {
        text: { type: "string", maxLength: 500 },
        due: { type: "string", format: "date" },
      },
      required: ["text"],
    },
    output: { type: "object", properties: { line: { type: "integer" } }, required: ["line"] },
  }),
  "/todo/tools/list.json": json({
    description: "List the project's todo items.",
    action: "read",
    entry: "todo.list",
    input: { type: "object", properties: {} },
    output: {
      type: "object",
      properties: { items: { type: "array", items: { $ref: "#/components/schemas/Item" } } },
    },
    components: { Item: { type: "object", properties: { text: { type: "string" } } } },
  }),

  "/todo/tools/peek.json": json({
    description: "Show any file by path (it should only ever see what the capability allows).",
    action: "read",
    entry: "todo.peek",
    input: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    output: { type: "object", properties: { text: { type: "string" } } },
  }),

  "/github/plugin.json": json({
    name: "github",
    version: "1.0.0",
    description: "Issues, via a remote MCP server",
  }),
  "/github/mcp.json": json({ mcpServers: { github: { type: "http", url: "{{MCP_GITHUB_URL}}" } } }),

  "/weather/plugin.json": json({
    name: "weather",
    version: "1.0.0",
    description: "A REST weather API",
  }),
  "/weather/openapi.json": json({
    openapi: "3.1.0",
    info: { title: "Weather", version: "1" },
    servers: [{ url: "{{WEATHER_URL}}" }],
    components: {
      securitySchemes: { apiKey: { type: "apiKey", in: "header", name: "X-Api-Key" } },
    },
    security: [{ apiKey: [] }],
    paths: {
      "/forecast/{city}": {
        get: {
          operationId: "forecast",
          summary: "Forecast for a city.",
          parameters: [
            { name: "city", in: "path", required: true, schema: { type: "string" } },
            { name: "days", in: "query", schema: { type: "integer", minimum: 1, maximum: 10 } },
            { name: "X-Units", in: "header", schema: { enum: ["metric", "imperial"] } },
          ],
          responses: {
            200: {
              description: "OK",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: { temps: { type: "array", items: { type: "number" } } },
                  },
                },
              },
            },
            404: { description: "Unknown city" },
          },
        },
      },
      "/stations/bulk": {
        post: {
          operationId: "addStations",
          summary: "Register several stations.",
          requestBody: {
            content: {
              "application/json": {
                schema: {
                  type: "array",
                  items: { type: "object", properties: { id: { type: "string" } } },
                },
              },
            },
          },
          responses: { 201: { description: "Created" } },
        },
      },
    },
  }),

  "/core/plugin.json": json({ name: "core", version: "1.0.0", description: "Agents" }),
  "/core/agents/coder/AGENT.md":
    "---\nname: coder\ntools: [todo/*, github/*, harness/members.list]\n---\nYou write code and keep the todo list.\n",
  "/core/agents/triager/AGENT.md":
    "---\nname: triager\ntools: [github/search_issues, github/create_issue, todo/list, weather/forecast]\n---\nYou triage issues.\n",
  "/core/agents/admin/AGENT.md":
    "---\nname: admin\ntools: ['*']\n---\nYou administer the project.\n",
};
