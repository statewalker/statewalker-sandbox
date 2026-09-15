import { newFanOutLogger } from "@logs/app";
import type { LoggerBackend, LogRecord } from "@sys";
import { describe, expect, it, vi } from "vitest";
import { newRecordingLogger } from "../support/logging.js";

const collecting = () => {
  const records: LogRecord[] = [];
  const backend: LoggerBackend = { write: (r) => records.push(r) };
  return { backend, records };
};

describe("B2 · fan-out logger", () => {
  it("with no backend, every call goes to the fallback logger — child metadata included", () => {
    const fallback = newRecordingLogger();
    const fan = newFanOutLogger({ fallback: fallback.logger });
    fan.logger.child({ module: "todos" }).info("todos:created", { id: "1" });
    expect(fallback.calls).toEqual([
      { level: "info", args: ["todos:created", { id: "1" }], metadata: { module: "todos" } },
    ]);
  });

  it("with backends, every call becomes one frozen record written to each of them", () => {
    const fallback = newRecordingLogger();
    const a = collecting();
    const b = collecting();
    const fan = newFanOutLogger({ fallback: fallback.logger, now: () => 1000 });
    fan.setBackends([a.backend, b.backend]);
    fan.logger.child({ module: "todos" }).child({ step: 1 }).warn("hello", 42);
    fan.logger.trace("second");
    expect(fallback.calls, "the fallback is not used while backends exist").toEqual([]);
    expect(a.records).toEqual(b.records);
    expect(a.records[0]).toEqual({
      seq: 1,
      at: 1000,
      level: "warn",
      args: ["hello", 42],
      metadata: { module: "todos", step: 1 },
      dropped: 0,
    });
    expect(a.records[1].seq).toBe(2);
    expect(Object.isFrozen(a.records[0])).toBe(true);
  });

  it("drops calls below its level, on both paths", () => {
    const fallback = newRecordingLogger();
    const a = collecting();
    const fan = newFanOutLogger({ level: "info", fallback: fallback.logger });
    fan.logger.debug("quiet");
    fan.setBackends([a.backend]);
    fan.logger.trace("quiet");
    expect(fallback.calls).toEqual([]);
    expect(a.records).toEqual([]);
  });

  it("drops and counts a record logged while records are being delivered — no recursion", () => {
    const a = collecting();
    const fan = newFanOutLogger({ fallback: newRecordingLogger().logger });
    const echo: LoggerBackend = { write: () => fan.logger.info("echo from inside a write") };
    fan.setBackends([echo, a.backend]);
    fan.logger.info("first");
    fan.logger.info("second");
    expect(a.records.map((r) => r.args[0])).toEqual(["first", "second"]);
    expect(fan.dropped()).toBe(2);
    expect(a.records[1].dropped, "a record carries the running count").toBe(1);
  });

  it("a throwing backend is reported and never stops the others", () => {
    const a = collecting();
    const fan = newFanOutLogger({ fallback: newRecordingLogger().logger });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      fan.setBackends([
        {
          write: () => {
            throw new Error("backend failed");
          },
        },
        a.backend,
      ]);
      expect(() => fan.logger.info("x")).not.toThrow();
      expect(a.records).toHaveLength(1);
      expect(errors).toHaveBeenCalled();
    } finally {
      errors.mockRestore();
    }
  });

  it("returns to the fallback when the last backend goes away", () => {
    const fallback = newRecordingLogger();
    const a = collecting();
    const fan = newFanOutLogger({ fallback: fallback.logger });
    fan.setBackends([a.backend]);
    fan.setBackends([]);
    fan.logger.info("back to console");
    expect(fallback.calls).toHaveLength(1);
  });
});
