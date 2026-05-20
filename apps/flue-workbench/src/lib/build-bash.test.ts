import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { describe, expect, it } from "vitest";
import { buildBash } from "./build-bash.js";

describe("buildBash", () => {
  it("returns an executor and a BashFactory", async () => {
    const files = new MemFilesApi();
    await files.mkdir("/workspace");
    const { executor, factory } = await buildBash({ files, cwd: "/workspace" });
    expect(executor).toBeDefined();
    expect(executor.commands).toBeInstanceOf(Array);
    expect(typeof executor.invokeTool).toBe("function");
    expect(typeof factory).toBe("function");
  });

  it("exposes Flue tools as bash commands via the executor", async () => {
    const files = new MemFilesApi();
    await files.mkdir("/workspace");

    const { factory } = await buildBash({
      files,
      cwd: "/workspace",
      tools: {
        // Executor names commands as `<namespace> <kebab-name>`. A tool path
        // without a dot is invokable only from js-exec, never as a bash command.
        "tools.echoTool": {
          description: "Echoes its `text` arg back",
          execute: async (args: { text: string }) => args.text,
        },
      },
    });

    const bash = await factory();
    // `tools.echoTool` → bash command `tools echo-tool --text "hello"`.
    const r = await bash.exec(`tools echo-tool --text "hello"`);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("hello");
  });

  it("model-facing factory survives with no tools", async () => {
    const files = new MemFilesApi();
    await files.mkdir("/workspace");
    const { factory } = await buildBash({ files, cwd: "/workspace" });
    const bash = await factory();
    const r = await bash.exec("echo ok");
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe("ok");
  });
});
