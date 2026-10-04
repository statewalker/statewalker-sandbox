import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { setProvider } from "@flue/runtime";
import { readText } from "@statewalker/webrun-files";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildFilesViews } from "../../src/lib/build-files-views.js";
import { createWorkbench, type Workbench } from "../../src/lib/create-workbench.js";
import { WorkbenchSecretMissingError } from "../../src/lib/errors.js";
import { FilesApiSecretStore } from "../../src/lib/files-api-secret-store.js";
import { FilesApiSessionStore } from "../../src/lib/files-api-session-store.js";
import type { Terminal } from "../../src/lib/terminal-contract.js";

// End-to-end through the real Flue 2 runtime (`start()` + `init()`), the
// FilesApi-backed sandbox and persistence — with pi-ai's faux provider
// standing in for Gemini, so no network and a scripted model.

const SESSION_ID = "workbench/repo/main";

function makeFakeTerminal(): Terminal & {
  output: () => string;
  type: (line: string) => Promise<void>;
} {
  const writes: string[] = [];
  const callbacks: ((data: string) => void)[] = [];
  return {
    write: (data) => void writes.push(data),
    writeln: (data) => void writes.push(`${data}\n`),
    clear: () => {
      writes.length = 0;
    },
    onData: (cb) => {
      callbacks.push(cb);
      return { dispose: () => void callbacks.splice(callbacks.indexOf(cb), 1) };
    },
    output: () => writes.join(""),
    // Type a line and wait until the shell has printed its next prompt.
    type: async (line: string) => {
      const prompts = countPrompts(writes.join(""));
      for (const cb of callbacks) cb(`${line}\r`);
      await waitFor(() => countPrompts(writes.join("")) > prompts);
    },
  };
}

/** User turns in a model context (Flue also sends a leading system entry). */
function userMessages(messages: readonly { role: string }[]): number {
  return messages.filter((m) => m.role === "user").length;
}

function countPrompts(text: string): number {
  return text.split("flue-workbench\x1b[0m:").length - 1;
}

async function waitFor(check: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("waitFor: timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("createWorkbench (Flue 2 runtime, faux model)", () => {
  let rootFiles: MemFilesApi;
  let faux: ReturnType<typeof fauxProvider>;
  let workbench: Workbench | undefined;

  beforeEach(async () => {
    rootFiles = new MemFilesApi();
    const secrets = new FilesApiSecretStore({
      systemFiles: buildFilesViews(rootFiles).systemFiles,
    });
    await secrets.set("GEMINI_API_KEY", "AIza-test");
    faux = fauxProvider({ provider: "faux", models: [{ id: "test-model" }] });
    setProvider(faux.provider);
  });

  afterEach(async () => {
    await workbench?.dispose();
    workbench = undefined;
  });

  const boot = (terminal: Terminal) =>
    createWorkbench({
      rootFiles,
      workspaceKey: "repo",
      terminal,
      defaultModel: "faux/test-model",
      onSecretRequest: async () => "",
    });

  it("`agent <prompt>` runs the model, its tools act on the workspace, and the reply streams", async () => {
    const term = makeFakeTerminal();
    workbench = await boot(term);
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("write", { path: "/workspace/hello.txt", content: "hi from the model" }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("Wrote hello.txt."),
    ]);

    await term.type("agent please write a file");

    expect(term.output()).toContain("[write]");
    expect(term.output()).toContain("Wrote hello.txt.");
    // The model-facing sandbox writes through FilesApi into the user view.
    expect(await readText(rootFiles, "/workspace/hello.txt")).toBe("hi from the model");
    // The human-facing bash sees the same file system.
    await term.type("cat hello.txt");
    expect(term.output()).toContain("hi from the model");
  });

  it("persists the conversation under /.settings/sessions and resumes it after a restart", async () => {
    const term = makeFakeTerminal();
    workbench = await boot(term);
    faux.setResponses([fauxAssistantMessage("first answer")]);
    await term.type("agent remember the word apple");
    await workbench.dispose();
    workbench = undefined;

    const sessions = new FilesApiSessionStore({ files: buildFilesViews(rootFiles).systemFiles });
    expect(await sessions.has(SESSION_ID)).toBe(true);

    // A fresh runtime over the same files continues the same conversation:
    // the second model call sees the first user turn in its context.
    let seenUserMessages = 0;
    faux.setResponses([
      (context) => {
        seenUserMessages = userMessages(context.messages);
        return fauxAssistantMessage("second answer");
      },
    ]);
    const term2 = makeFakeTerminal();
    workbench = await boot(term2);
    await term2.type("agent what was the word?");
    expect(term2.output()).toContain("second answer");
    expect(seenUserMessages).toBe(2);
  });

  it("`session reset` wipes the conversation and the next prompt starts fresh", async () => {
    const term = makeFakeTerminal();
    workbench = await boot(term);
    faux.setResponses([fauxAssistantMessage("first answer")]);
    await term.type("agent hello");

    await term.type("session reset");
    const sessions = new FilesApiSessionStore({ files: buildFilesViews(rootFiles).systemFiles });
    expect(await sessions.has(SESSION_ID)).toBe(false);

    let seenUserMessages = 0;
    faux.setResponses([
      (context) => {
        seenUserMessages = userMessages(context.messages);
        return fauxAssistantMessage("fresh answer");
      },
    ]);
    await term.type("agent hello again");
    expect(term.output()).toContain("fresh answer");
    expect(seenUserMessages).toBe(1);
  });

  it("a model error surfaces on the terminal and the shell stays usable", async () => {
    const term = makeFakeTerminal();
    workbench = await boot(term);
    faux.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "boom" })]);
    await term.type("agent fail please");
    expect(term.output()).toMatch(/agent: /);
    await term.type("echo still-alive");
    expect(term.output()).toContain("still-alive");
  });

  it("boot gating stays atomic: a rejected key request starts no runtime", async () => {
    const empty = new MemFilesApi();
    await expect(
      createWorkbench({
        rootFiles: empty,
        workspaceKey: "repo",
        terminal: makeFakeTerminal(),
        defaultModel: "faux/test-model",
        onSecretRequest: async () => {
          throw new Error("dismissed");
        },
      }),
    ).rejects.toBeInstanceOf(WorkbenchSecretMissingError);
    // Had a runtime leaked, this second boot would throw "already configured".
    workbench = await boot(makeFakeTerminal());
  });
});
