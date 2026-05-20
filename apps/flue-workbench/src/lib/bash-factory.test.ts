import { writeText } from "@statewalker/webrun-files";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { Bash } from "just-bash";
import { describe, expect, it } from "vitest";
import { filesApiBashFactory } from "./bash-factory.js";
import { FilesApiAdapter } from "./files-api-adapter.js";

describe("filesApiBashFactory", () => {
  it("returns a BashFactory whose result satisfies BashLike", async () => {
    const files = new MemFilesApi();
    await files.mkdir("/workspace");
    const factory = filesApiBashFactory({ files, cwd: "/workspace" });
    const bash = await factory();
    expect(typeof bash.exec).toBe("function");
    expect(typeof bash.getCwd).toBe("function");
    expect(bash.getCwd()).toBe("/workspace");
    expect(bash.fs).toBeDefined();
  });

  it("passes through customCommands to the constructed Bash", async () => {
    const files = new MemFilesApi();
    await files.mkdir("/workspace");

    // A trivially named custom command lets us prove the wiring.
    const { defineCommand } = await import("just-bash");
    const ping = defineCommand("ping-test", async () => ({
      stdout: "pong\n",
      stderr: "",
      exitCode: 0,
    }));

    const factory = filesApiBashFactory({
      files,
      cwd: "/workspace",
      customCommands: [ping],
    });
    const bash = await factory();
    const r = await bash.exec("ping-test");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("pong\n");
  });

  describe("Spec scenario: two-bash sharing one FilesApiAdapter is FS-coherent", () => {
    it("a write by the model-facing Bash is visible to the human-facing Bash immediately", async () => {
      const files = new MemFilesApi();
      await files.mkdir("/workspace");

      // Two independent Bash instances backed by the same FilesApi root.
      const modelBash = await filesApiBashFactory({ files, cwd: "/workspace" })();
      const humanBash = new Bash({
        fs: new FilesApiAdapter({ files, cwd: "/workspace" }),
        cwd: "/workspace",
      });

      // Model-side: write a file via bash's writeFile (the path the agent's
      // `write` tool would use internally).
      await modelBash.fs.writeFile("/workspace/out.txt", "hi");

      // Human-side: ls and cat the file through a different Bash instance.
      const ls = await humanBash.exec("ls /workspace");
      expect(ls.exitCode).toBe(0);
      expect(ls.stdout).toContain("out.txt");

      const cat = await humanBash.exec("cat /workspace/out.txt");
      expect(cat.exitCode).toBe(0);
      expect(cat.stdout).toBe("hi");
    });

    it("a write by the human-facing Bash is visible to the model-facing Bash", async () => {
      const files = new MemFilesApi();
      await files.mkdir("/workspace");
      await writeText(files, "/workspace/in.txt", "hi\n");

      const modelBash = await filesApiBashFactory({ files, cwd: "/workspace" })();
      const humanBash = new Bash({
        fs: new FilesApiAdapter({ files, cwd: "/workspace" }),
        cwd: "/workspace",
      });

      // Human-side: overwrite in.txt via bash's echo > redirect.
      const w = await humanBash.exec("echo replaced > /workspace/in.txt");
      expect(w.exitCode).toBe(0);

      // Model-side: read through the model bash's fs.readFile.
      const content = await modelBash.fs.readFile("/workspace/in.txt");
      expect(content.trim()).toBe("replaced");
    });
  });
});
