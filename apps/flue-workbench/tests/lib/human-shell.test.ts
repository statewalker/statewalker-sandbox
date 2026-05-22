import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { describe, expect, it } from "vitest";
import { attachHumanShell } from "../../src/lib/human-shell.js";
import type { Terminal } from "../../src/lib/terminal-contract.js";

function makeFakeTerminal(): Terminal & {
  writes: string[];
  emit: (data: string) => Promise<void>;
} {
  const writes: string[] = [];
  const callbacks: ((data: string) => void | Promise<void>)[] = [];
  return {
    writes,
    write: (data) => writes.push(data),
    writeln: (data) => writes.push(`${data}\n`),
    clear: () => {
      writes.length = 0;
    },
    onData: (cb) => {
      callbacks.push(cb);
      return { dispose: () => void callbacks.splice(callbacks.indexOf(cb), 1) };
    },
    // The real xterm.onData fires synchronously and doesn't await async
    // handlers. The shell's serialization chain captures the in-flight
    // processing promise so the next `emit` call can wait for the previous
    // chunk to drain before asserting.
    emit: async (data: string) => {
      for (const cb of callbacks) await cb(data);
    },
  };
}

async function makeShell(terminal: Terminal) {
  const files = new MemFilesApi();
  await files.mkdir("/workspace");
  return attachHumanShell({
    files,
    cwd: "/workspace",
    terminal,
    customCommands: [],
  });
}

describe("attachHumanShell", () => {
  it("backspace via \\x7f erases the visible character and the buffer", async () => {
    const term = makeFakeTerminal();
    const shell = await makeShell(term);

    await term.emit("lsx\x7f\r"); // type "lsx", backspace, enter — should run "ls"

    // Look for the "ls" execution by spotting the stdout reaching the terminal
    // does not contain a literal \x7f anywhere in command echo.
    const all = term.writes.join("");
    expect(all).not.toContain("\x7f");
    // The erase sequence `\b \b` should appear at least once.
    expect(all).toContain("\b \b");

    shell.dispose();
  });

  it("backspace via \\b also erases", async () => {
    const term = makeFakeTerminal();
    const shell = await makeShell(term);

    await term.emit("lsx\b\r");

    const all = term.writes.join("");
    expect(all).toContain("\b \b");

    shell.dispose();
  });

  it("two chunks arriving while a slow command runs are serialized", async () => {
    const term = makeFakeTerminal();
    const files = new MemFilesApi();
    await files.mkdir("/workspace");

    // Inject a custom command that takes a controllable amount of time so we
    // can race two `\r`-terminated lines through `onData`.
    let releaseSlow: () => void = () => {};
    const slowDone = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });
    const { defineCommand } = await import("just-bash");
    const slow = defineCommand("slow", async () => {
      await slowDone;
      return { stdout: "slow-done\n", stderr: "", exitCode: 0 };
    });

    const shell = attachHumanShell({
      files,
      cwd: "/workspace",
      terminal: term,
      customCommands: [slow],
    });

    // The shell's onData callback is synchronous (it just queues onto the
    // processing chain), so both emits return immediately.
    await term.emit("slow\r");
    await term.emit("echo hello\r");

    // Release the slow command — both chunks should now drain in order.
    releaseSlow();

    // Poll for both markers to appear in the terminal output.
    const deadline = Date.now() + 1000;
    while (Date.now() < deadline) {
      const all = term.writes.join("");
      if (all.includes("slow-done") && all.includes("hello")) break;
      await new Promise((r) => setTimeout(r, 5));
    }

    const all = term.writes.join("");
    const slowIdx = all.indexOf("slow-done");
    const helloIdx = all.indexOf("hello");
    expect(slowIdx).toBeGreaterThanOrEqual(0);
    expect(helloIdx).toBeGreaterThan(slowIdx);

    shell.dispose();
  });
});
