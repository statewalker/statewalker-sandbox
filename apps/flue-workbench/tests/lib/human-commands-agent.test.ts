import {
  type AgentReply,
  AgentRunError,
  type DispatchReceipt,
  type FlueEvent,
} from "@flue/runtime";
import { describe, expect, it } from "vitest";
import { newAgentCommand } from "../../src/lib/human-commands.js";
import type { Terminal } from "../../src/lib/terminal-contract.js";

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

/** Decorate an event payload with the Flue 2 envelope fields (`v`, index, time). */
let eventIndex = 0;
function ev(payload: Record<string, unknown>): FlueEvent {
  return {
    v: 3,
    eventIndex: eventIndex++,
    timestamp: "2026-05-21T00:00:00.000Z",
    instanceId: "workbench/x/main",
    ...payload,
  } as unknown as FlueEvent;
}

/**
 * A controllable stub of Flue 2's `AgentInstanceHandle` (`init(agent, { id })`).
 *
 * `dispatch` admits immediately; `read` hangs until `resolveReply(text)` /
 * `rejectReply(err)` is called from the test, or until its signal aborts.
 * `abort()` models the durable abort: the pending read settles with
 * `AgentRunError` outcome `aborted`, as the runtime does. `emit(event)`
 * dispatches a FlueEvent to all subscribers. Lets us race timing between
 * stream events, abort signals, and settlement deterministically.
 */
function makeFakeInstance() {
  const subscribers: ((e: FlueEvent) => void)[] = [];
  let resolveReply: ((text: string) => void) | null = null;
  let rejectReply: ((err: unknown) => void) | null = null;
  const dispatched: string[] = [];
  let abortCalls = 0;

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
    resolveReply: (text: string) => resolveReply?.(text),
    rejectReply: (err: unknown) => rejectReply?.(err),
    dispatched,
    abortCalls: () => abortCalls,
    dispatch: async (message: unknown): Promise<DispatchReceipt> => {
      dispatched.push(String(message));
      return { submissionId: `sub_${dispatched.length}`, acceptedAt: "now", uid: "uid-1" };
    },
    read: (receipt: DispatchReceipt, options?: { signal?: AbortSignal }) =>
      new Promise<AgentReply>((resolve, reject) => {
        if (options?.signal?.aborted) {
          reject(options.signal.reason);
          return;
        }
        resolveReply = (text) => resolve({ text, data: {}, submissionId: receipt.submissionId });
        rejectReply = reject;
        options?.signal?.addEventListener(
          "abort",
          () => reject(options.signal?.reason ?? new DOMException("Aborted", "AbortError")),
          { once: true },
        );
      }),
    abort: async () => {
      abortCalls++;
      rejectReply?.(new AgentRunError({ outcome: "aborted", submissionId: "sub_1" }));
    },
  };
}

// ── Tests ─────────────────────────────────────────────────────────

describe("newAgentCommand", () => {
  describe("Spec scenario: text deltas reach the terminal before resolution", () => {
    it("writes text_delta events incrementally via Terminal.write", async () => {
      const term = makeFakeTerminal();
      const instance = makeFakeInstance();
      const cmd = newAgentCommand({
        instance: () => instance,
        subscribeEvent: instance.subscribeEvent,
        term,
      });

      // Fire the command (don't await yet).
      const running = cmd.execute(["hello"], {} as never);

      // Emit a sequence of deltas; each should be written immediately.
      instance.emit(ev({ type: "text_delta", text: "Hel" }));
      await Promise.resolve();
      instance.emit(ev({ type: "text_delta", text: "lo" }));
      await Promise.resolve();
      instance.emit(ev({ type: "text_delta", text: "!\n" }));
      await Promise.resolve();

      // At this point the terminal should already have the text — before resolve.
      const written = term.writes.join("");
      expect(written).toContain("Hello!");

      // Now resolve so the running command can finish.
      instance.resolveReply("Hello!");
      const result = await running;
      expect(result.exitCode).toBe(0);
    });

    it("newlines in deltas are normalized to CR-LF so xterm renders them correctly", async () => {
      const term = makeFakeTerminal();
      const instance = makeFakeInstance();
      const cmd = newAgentCommand({
        instance: () => instance,
        subscribeEvent: instance.subscribeEvent,
        term,
      });
      const running = cmd.execute(["go"], {} as never);
      instance.emit(ev({ type: "text_delta", text: "line1\nline2\n" }));
      await Promise.resolve();
      instance.resolveReply("done");
      await running;

      expect(term.writes.join("")).toContain("line1\r\nline2\r\n");
    });
  });

  describe("Spec scenario: tool_start emits a decoration", () => {
    it("writes a label containing the tool name", async () => {
      const term = makeFakeTerminal();
      const instance = makeFakeInstance();
      const cmd = newAgentCommand({
        instance: () => instance,
        subscribeEvent: instance.subscribeEvent,
        term,
      });
      const running = cmd.execute(["go"], {} as never);
      instance.emit(ev({ type: "tool_start", toolName: "read", toolCallId: "tc1" }));
      await Promise.resolve();
      instance.resolveReply("done");
      await running;

      expect(term.writes.join("")).toContain("[read]");
    });
  });

  describe("Spec scenario: usage and arg-empty edge cases", () => {
    it("exits 2 with a usage message when no prompt is supplied", async () => {
      const term = makeFakeTerminal();
      const instance = makeFakeInstance();
      const cmd = newAgentCommand({
        instance: () => instance,
        subscribeEvent: instance.subscribeEvent,
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
      const instance = makeFakeInstance();
      const cmd = newAgentCommand({
        instance: () => instance,
        subscribeEvent: instance.subscribeEvent,
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
      const instance = makeFakeInstance();
      const cmd = newAgentCommand({
        instance: () => instance,
        subscribeEvent: instance.subscribeEvent,
        term,
      });
      expect(instance.subscriberCount()).toBe(0);

      const controller = new AbortController();
      const running = cmd.execute(["go"], { signal: controller.signal } as never);

      // While running, there should be exactly one subscriber.
      await Promise.resolve();
      expect(instance.subscriberCount()).toBe(1);

      controller.abort();
      await running;
      // After abort, cleanup must run — no leaked subscribers.
      expect(instance.subscriberCount()).toBe(0);
    });
  });
  describe("Spec scenario: Flue 2 instance handle semantics", () => {
    it("dispatches the joined prompt text to the agent instance", async () => {
      const term = makeFakeTerminal();
      const instance = makeFakeInstance();
      const cmd = newAgentCommand({
        instance: () => instance,
        subscribeEvent: instance.subscribeEvent,
        term,
      });
      const running = cmd.execute(["list", "the", "files"], {} as never);
      await Promise.resolve();
      instance.resolveReply("done");
      await running;
      expect(instance.dispatched).toEqual(["list the files"]);
    });

    it("Ctrl-C requests a durable abort of the instance's work, not just a local cancel", async () => {
      const term = makeFakeTerminal();
      const instance = makeFakeInstance();
      const cmd = newAgentCommand({
        instance: () => instance,
        subscribeEvent: instance.subscribeEvent,
        term,
      });
      const controller = new AbortController();
      const running = cmd.execute(["long"], { signal: controller.signal } as never);
      // Let dispatch admit and read start waiting.
      await new Promise((r) => setTimeout(r, 0));
      controller.abort();
      const result = await running;
      expect(result.exitCode).toBe(130);
      expect(instance.abortCalls()).toBeGreaterThanOrEqual(1);
      expect(term.writes.join("")).toContain("[aborted]");
    });

    it("a run that settles aborted elsewhere (AgentRunError) also exits 130", async () => {
      const term = makeFakeTerminal();
      const instance = makeFakeInstance();
      const cmd = newAgentCommand({
        instance: () => instance,
        subscribeEvent: instance.subscribeEvent,
        term,
      });
      const running = cmd.execute(["go"], {} as never);
      await new Promise((r) => setTimeout(r, 0));
      instance.rejectReply(new AgentRunError({ outcome: "aborted", submissionId: "sub_1" }));
      expect((await running).exitCode).toBe(130);
    });

    it("a failed run exits 1 and reports the error on stderr", async () => {
      const term = makeFakeTerminal();
      const instance = makeFakeInstance();
      const cmd = newAgentCommand({
        instance: () => instance,
        subscribeEvent: instance.subscribeEvent,
        term,
      });
      const running = cmd.execute(["go"], {} as never);
      await new Promise((r) => setTimeout(r, 0));
      instance.rejectReply(
        new AgentRunError({
          outcome: "failed",
          submissionId: "sub_1",
          cause: new Error("quota exceeded"),
        }),
      );
      const result = await running;
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toMatch(/^agent: /);
      expect(instance.subscriberCount()).toBe(0);
    });
  });
});
