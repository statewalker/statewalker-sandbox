import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { Bash } from "just-bash";
import { beforeEach, describe, expect, it } from "vitest";
import { buildFilesViews } from "./build-files-views.js";
import { FilesApiAdapter } from "./files-api-adapter.js";
import { FilesApiSecretStore } from "./files-api-secret-store.js";
import { FilesApiSessionStore } from "./files-api-session-store.js";
import { newSecretCommand, newSessionCommand } from "./static-commands.js";

describe("static-commands", () => {
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
      // Seed a fake session.
      await sessions.save("workbench/repo-foo/main", {
        version: 3,
        entries: [],
        leafId: null,
        metadata: {},
        createdAt: "x",
        updatedAt: "y",
      } as never);
      expect(await sessions.load("workbench/repo-foo/main")).not.toBeNull();

      const bash = humanBash([
        newSessionCommand({ sessions, sessionId: "workbench/repo-foo/main" }),
      ]);
      const r = await bash.exec("session reset");
      expect(r.exitCode).toBe(0);
      expect(await sessions.load("workbench/repo-foo/main")).toBeNull();
    });

    it("usage message when invoked without args", async () => {
      const bash = humanBash([newSessionCommand({ sessions, sessionId: "workbench/x/main" })]);
      const r = await bash.exec("session");
      expect(r.exitCode).toBe(2);
      expect(r.stderr).toMatch(/usage/i);
    });
  });
});
