// DERIVED-FROM-NOTE: 11-Prototype 1 API Reference.md §6, including the
// "Verified output" paragraph, which is asserted here field by field
// DERIVED-FROM-NOTE: 07-Projection to OpenAPI and MCP Tools.md §2, §4 and §5

import { CommandsRegistry } from "@statewalker/shared-commands";
import { describe, expect, it } from "vitest";
import { getRegistry, newShellContext } from "../src/context.js";
import {
  commandKeyFromToolName,
  type ProjectionPolicy,
  projectToOpenApi,
  projectToTools,
} from "../src/projection.js";

/** The hand-written side table. `shell:dialog:open` is deliberately absent. */
const policy: ProjectionPolicy = {
  "shell:notify": "tool",
  "shell:view:open": "tool",
  "shell:palette:show": "hazardous",
};

const registry = () => getRegistry(newShellContext());

describe("deny by default", () => {
  it("projects only the keys opted in as `tool`", async () => {
    const tools = await projectToTools(registry(), policy);
    expect(tools.map((t) => t.name)).toEqual(["shell__notify", "shell__view__open"]);
  });

  it("treats an unlisted key as ui-only — `shell:dialog:open` is never a tool", async () => {
    const tools = await projectToTools(registry(), {});
    expect(tools).toEqual([]);
  });

  it("withholds `hazardous` unless includeHazardous is passed", async () => {
    const without = await projectToTools(registry(), policy);
    expect(without.map((t) => t.name)).not.toContain("shell__palette__show");
    const with_ = await projectToTools(registry(), policy, {
      includeHazardous: true,
    });
    expect(with_.map((t) => t.name)).toContain("shell__palette__show");
    expect(with_.find((t) => t.name === "shell__palette__show")?.mode).toBe("hazardous");
  });

  it("an explicit `ui-only` is excluded just like an unlisted key", async () => {
    const tools = await projectToTools(registry(), {
      "shell:dialog:open": "ui-only",
    });
    expect(tools).toEqual([]);
  });
});

describe("tool names", () => {
  it("replaces `:` with `__`", async () => {
    const tools = await projectToTools(registry(), { "shell:notify": "tool" });
    expect(tools[0]?.name).toBe("shell__notify");
  });

  it("round-trips, including multi-segment keys", () => {
    for (const key of ["shell:notify", "shell:dialog:open", "peer:12D3KooWabc:shell:view:open"]) {
      expect(commandKeyFromToolName(key.replaceAll(":", "__"))).toBe(key);
    }
  });
});

describe("the verified output — `shell:notify`", () => {
  it("carries a draft-2020-12 input schema with the stated shape", async () => {
    const [tool] = await projectToTools(registry(), { "shell:notify": "tool" });
    const schema = tool?.inputSchema as Record<string, unknown>;
    expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(schema.required).toEqual(["message"]);
    expect(schema.additionalProperties).toBe(false);
    const props = schema.properties as Record<string, Record<string, unknown>>;
    expect(props.message).toMatchObject({ type: "string" });
    expect(props.severity).toMatchObject({
      type: "string",
      enum: ["info", "warning", "error"],
    });
    expect(props.timeoutMs).toMatchObject({
      type: "integer",
      exclusiveMinimum: 0,
    });
  });

  it("carries an output schema and a description, with no extra authoring", async () => {
    const [tool] = await projectToTools(registry(), { "shell:notify": "tool" });
    expect(tool?.description).toBe("Show a transient notification to the user.");
    expect(tool?.outputSchema).toMatchObject({
      type: "object",
      required: ["id"],
    });
  });
});

describe("OpenAPI", () => {
  it("emits POST /commands/{key} with the raw key in the path", async () => {
    const doc = await projectToOpenApi(registry(), policy, {
      title: "httpeers shell",
      version: "0.1.0",
    });
    const paths = doc.paths as Record<string, Record<string, never>>;
    expect(Object.keys(paths)).toContain("/commands/shell:notify");
    expect(paths["/commands/shell:notify"]?.post).toBeDefined();
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.info).toEqual({ title: "httpeers shell", version: "0.1.0" });
  });

  it("carries the mode in the x-httpeers-projection extension", async () => {
    const doc = await projectToOpenApi(registry(), policy, {
      title: "t",
      version: "1",
    });
    const paths = doc.paths as Record<string, { post: Record<string, unknown> }>;
    expect(paths["/commands/shell:notify"]?.post["x-httpeers-projection"]).toBe("tool");
    expect(paths["/commands/shell:palette:show"]?.post["x-httpeers-projection"]).toBe("hazardous");
    // ui-only never reaches the document.
    expect(paths["/commands/shell:dialog:open"]).toBeUndefined();
  });

  it("maps label to summary, description to description, and the schemas to body and 200", async () => {
    const doc = await projectToOpenApi(
      registry(),
      { "shell:notify": "tool" },
      {
        title: "t",
        version: "1",
      },
    );
    const op = (doc.paths as Record<string, { post: Record<string, never> }>)[
      "/commands/shell:notify"
    ]?.post as unknown as Record<string, unknown>;
    expect(op.operationId).toBe("shell:notify");
    expect(op.summary).toBe("Notify");
    expect(op.description).toBe("Show a transient notification to the user.");
    const body = op.requestBody as {
      content: { "application/json": { schema: Record<string, unknown> } };
    };
    expect(body.content["application/json"].schema.required).toEqual(["message"]);
    const responses = op.responses as Record<
      string,
      { content: { "application/json": { schema: Record<string, unknown> } } }
    >;
    expect(responses["200"]?.content["application/json"].schema.required).toEqual(["id"]);
  });
});

describe("the capability gate and the tool list are the same mechanism", () => {
  it("an agent holding a restricted registry sees a smaller set of tools", async () => {
    const gated = CommandsRegistry.filter(registry(), (d) => d.key !== "shell:view:open");
    const tools = await projectToTools(gated, policy);
    expect(tools.map((t) => t.name)).toEqual(["shell__notify"]);
  });

  it("a peer's namespaced commands project as namespaced tools", async () => {
    const mounted = CommandsRegistry.namespace(registry(), "peer:12D3KooWabc:");
    const tools = await projectToTools(mounted, {
      "peer:12D3KooWabc:shell:notify": "tool",
    });
    expect(tools.map((t) => t.name)).toEqual(["peer__12D3KooWabc__shell__notify"]);
    expect(commandKeyFromToolName(tools[0]?.name ?? "")).toBe("peer:12D3KooWabc:shell:notify");
  });
});
