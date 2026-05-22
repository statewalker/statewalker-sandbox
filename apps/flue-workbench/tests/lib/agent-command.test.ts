import type { FlueEvent } from "@flue/runtime";
import { describe, expect, it } from "vitest";
import { newAgentCommand } from "./agent-command.js";
import type { Terminal } from "./terminal-contract.js";

// ── Minimal fakes ─────────────────────────────────────────────────

function makeFakeTerminal(): Terminal & {
  writes: string[];
  emit: (data: string) => void;
} {
  const writes: string[] = [];
  const dataCallbacks: ((data: string) => void)[] = [];
  return {
    writes,
    write: (data) => writes.push(data),
    writeln: (data) => writes.push(`${data}\n`),
    clear: () => {
      writes.length = 0;
    },
    onData: (cb) => {
      dataCallbacks.push(cb);
      return {
        dispose: () => {
          const i = dataCallbacks.indexOf(cb);
          if (i >= 0) dataCallbacks.splice(i, 1);
        },
      };
    },
    emit: (data) => {
      for (const cb of dataCallbacks) cb(data);
    },
  };
}

/**
 * A controllable stub session.
 *
 * `prompt` returns a CallHandle that hangs until `resolvePrompt(text)` is
 * called from the test, or until aborted via its signal. `emit(event)`
 * dispatches a FlueEvent to all subscribers. Lets us race timing between
 * stream events, abort signals, and prompt resolution deterministically.
 */
function makeFakeSession() {
  const subscribers: ((e: FlueEvent) => void)[] = [];
  let resolvePrompt: ((text: string) => void) | null = null;
  let rejectPrompt: ((err: unknown) => void) | null = null;

  return {
    subscribeEvent: (cb: (e: FlueEvent) => void) => {
      subscribers.push(cb);
      return () => {
        const i = subscribers.indexOf(cb);
        if (i >= 0) subscribers.splice(i, 1);
      };
    },
    emit: (event: FlueEvent) => {
      for (const cb of subscribers) cb(event);
    },
    subscriberCount: () => subscribers.length,
    resolvePrompt: (text: string) => resolvePrompt?.(text),
    rejectPrompt: (err: unknown) => rejectPrompt?.(err),
    prompt: (_text: string, options?: { signal?: AbortSignal }) => {
      const controller = new AbortController();
      const signal = controller.signal;
      // Wire the external signal so abort() propagates.
      if (options?.signal) {
        options.signal.addEventListener("abort", () => controller.abort(options.signal?.reason), {
          once: true,
        });
      }
      const promise = new Promise<{ text: string }>((resolve, reject) => {
        resolvePrompt = (text) => resolve({ text });
        rejectPrompt = reject;
        signal.addEventListener("abort", () => {
          const e: Error & { name: string } = new Error("Aborted");
          e.name = "AbortError";
          reject(e);
        });
      });
      return Object.assign(promise, {
        signal,
        abort: (reason?: unknown) => controller.abort(reason),
      });
    },
  };
}

// ── Tests ─────────────────────────────────────────────────────────

describe("newAgentCommand", () => {
  describe("Spec scenario: text deltas reach the terminal before resolution", () => {
    it("writes text_delta events incrementally via Terminal.write", async () => {
      const term = makeFakeTerminal();
      const session = makeFakeSession();
      const cmd = newAgentCommand({
        session: () => session as never,
        subscribeEvent: session.subscribeEvent,
        term,
      });

      // Fire the command (don't await yet).
      const running = cmd.execute(["hello"], {} as never);

      // Emit a sequence of deltas; each should be written immediately.
      session.emit({ type: "text_delta", text: "Hel" });
      await Promise.resolve();
      session.emit({ type: "text_delta", text: "lo" });
      await Promise.resolve();
      session.emit({ type: "text_delta", text: "!\n" });
      await Promise.resolve();

      // At this point the terminal should already have the text — before resolve.
      const written = term.writes.join("");
      expect(written).toContain("Hello!");

      // Now resolve so the running command can finish.
      session.resolvePrompt("Hello!");
      const result = await running;
      expect(result.exitCode).toBe(0);
    });

    it("newlines in deltas are normalized to CR-LF so xterm renders them correctly", async () => {
      const term = makeFakeTerminal();
      const session = makeFakeSession();
      const cmd = newAgentCommand({
        session: () => session as never,
        subscribeEvent: session.subscribeEvent,
        term,
      });
      const running = cmd.execute(["go"], {} as never);
      session.emit({ type: "text_delta", text: "line1\nline2\n" });
      await Promise.resolve();
      session.resolvePrompt("done");
      await running;

      expect(term.writes.join("")).toContain("line1\r\nline2\r\n");
    });
  });

  describe("Spec scenario: tool_start emits a decoration", () => {
    it("writes a label containing the tool name", async () => {
      const term = makeFakeTerminal();
      const session = makeFakeSession();
      const cmd = newAgentCommand({
        session: () => session as never,
        subscribeEvent: session.subscribeEvent,
        term,
      });
      const running = cmd.execute(["go"], {} as never);
      session.emit({ type: "tool_start", toolName: "read", toolCallId: "tc1" });
      await Promise.resolve();
      session.resolvePrompt("done");
      await running;

      expect(term.writes.join("")).toContain("[read]");
    });
  });

  describe("Spec scenario: usage and arg-empty edge cases", () => {
    it("exits 2 with a usage message when no prompt is supplied", async () => {
      const term = makeFakeTerminal();
      const session = makeFakeSession();
      const cmd = newAgentCommand({
        session: () => session as never,
        subscribeEvent: session.subscribeEvent,
        term,
      });
      const result = await cmd.execute([], {} as never);
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toMatch(/usage/i);
    });
  });

  describe("Spec scenario: cancellation via Ctrl-C", () => {
    it("aborts the in-flight prompt and returns exit code 130", async () => {
      const term = makeFakeTerminal();
      const session = makeFakeSession();
      const cmd = newAgentCommand({
        session: () => session as never,
        subscribeEvent: session.subscribeEvent,
        term,
      });

      // Pass a context-supplied signal that we control.
      const controller = new AbortController();
      const running = cmd.execute(["long"], { signal: controller.signal } as never);

      // Abort mid-flight.
      controller.abort();
      const result = await running;

      expect(result.exitCode).toBe(130);
    });

    it("cleans up the event subscription after the call (even on abort)", async () => {
      const term = makeFakeTerminal();
      const session = makeFakeSession();
      const cmd = newAgentCommand({
        session: () => session as never,
        subscribeEvent: session.subscribeEvent,
        term,
      });
      expect(session.subscriberCount()).toBe(0);

      const controller = new AbortController();
      const running = cmd.execute(["go"], { signal: controller.signal } as never);

      // While running, there should be exactly one subscriber.
      await Promise.resolve();
      expect(session.subscriberCount()).toBe(1);

      controller.abort();
      await running;
      // After abort, cleanup must run — no leaked subscribers.
      expect(session.subscriberCount()).toBe(0);
    });
  });
});
