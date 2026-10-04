import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { Bash } from "just-bash";
import { beforeEach, describe, expect, it } from "vitest";
import { buildFilesViews } from "../../src/lib/build-files-views.js";
import { FilesApiAdapter } from "../../src/lib/files-api-adapter.js";
import { FilesApiSecretStore } from "../../src/lib/files-api-secret-store.js";
import { FilesApiSessionStore } from "../../src/lib/files-api-session-store.js";
import { newSecretCommand, newSessionCommand } from "../../src/lib/human-commands.js";

describe("human-commands (secret + session)", () => {
  let rootFiles: MemFilesApi;
  let userFiles: ReturnType<typeof buildFilesViews>["userFiles"];
  let systemFiles: ReturnType<typeof buildFilesViews>["systemFiles"];
  let secrets: FilesApiSecretStore;
  let sessions: FilesApiSessionStore;

  beforeEach(async () => {
    rootFiles = new MemFilesApi();
    await rootFiles.mkdir("/workspace");
    const views = buildFilesViews(rootFiles);
    userFiles = views.userFiles;
    systemFiles = views.systemFiles;
    secrets = new FilesApiSecretStore({ systemFiles });
    sessions = new FilesApiSessionStore({ files: systemFiles });
  });

  function humanBash(extraCommands: Array<ReturnType<typeof newSecretCommand>>) {
    return new Bash({
      fs: new FilesApiAdapter({ files: userFiles, cwd: "/workspace" }),
      cwd: "/workspace",
      customCommands: extraCommands,
    });
  }

  describe("secret command", () => {
    it("set + get round-trips through the bash command", async () => {
      const bash = humanBash([newSecretCommand({ secrets })]);
      const setR = await bash.exec("secret set GEMINI_API_KEY AIza-from-bash");
      expect(setR.exitCode).toBe(0);

      const getR = await bash.exec("secret get GEMINI_API_KEY");
      expect(getR.exitCode).toBe(0);
      expect(getR.stdout.trim()).toBe("AIza-from-bash");
    });

    it("list outputs keys one per line", async () => {
      await secrets.set("A", "x");
      await secrets.set("B", "y");
      const bash = humanBash([newSecretCommand({ secrets })]);
      const r = await bash.exec("secret list");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("A");
      expect(r.stdout).toContain("B");
    });

    it("usage message when invoked without args", async () => {
      const bash = humanBash([newSecretCommand({ secrets })]);
      const r = await bash.exec("secret");
      expect(r.exitCode).toBe(2);
      expect(r.stderr).toMatch(/usage/i);
    });

    it("unknown subcommand exits non-zero with usage", async () => {
      const bash = humanBash([newSecretCommand({ secrets })]);
      const r = await bash.exec("secret weird-op");
      expect(r.exitCode).not.toBe(0);
      expect(r.stderr).toMatch(/usage|weird-op/i);
    });
  });

  describe("session command", () => {
    it("reset wipes the persisted session for the configured id", async () => {
      // Seed a conversation the way Flue 2's runtime persists one: a
      // canonical stream for the agent instance `workbench/repo-foo/main`.
      const id = "workbench/repo-foo/main";
      const path = `agents/flue-workbench/${id}`;
      await sessions.migrate();
      const { conversationStreamStore } = await sessions.connect();
      await conversationStreamStore.createStream(path, {
        agentName: "flue-workbench",
        instanceId: id,
      });
      expect(await sessions.has(id)).toBe(true);

      const bash = humanBash([newSessionCommand({ sessions, sessionId: id })]);
      const r = await bash.exec("session reset");
      expect(r.exitCode).toBe(0);
      expect(await sessions.has(id)).toBe(false);
    });

    it("usage message when invoked without args", async () => {
      const bash = humanBash([newSessionCommand({ sessions, sessionId: "workbench/x/main" })]);
      const r = await bash.exec("session");
      expect(r.exitCode).toBe(2);
      expect(r.stderr).toMatch(/usage/i);
    });
  });
});
