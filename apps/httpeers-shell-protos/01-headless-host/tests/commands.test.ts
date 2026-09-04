// DERIVED-FROM-NOTE: 11-Prototype 1 API Reference.md §5 (the four keys and
// policies, the input/output shapes, the listener contract table)
// DERIVED-FROM-NOTE: 10-Prototype 1 Functional Description.md §3.1 and §3.2
// (the two substrate defects — recorded as passing tests so they cannot rot
// into a stale comment)

import { describe, expect, it, vi } from "vitest";
import type {
  CommandDeclaration,
  CommandListener,
} from "@statewalker/shared-commands";
import { CommandError } from "@statewalker/shared-commands";
import { getCommands, getRegistry, newAppContext, newShellContext } from "../src/context.js";
import {
  NotifyCommand,
  OpenDialogCommand,
  OpenViewCommand,
  ShowPaletteCommand,
  shellCommands,
} from "../src/commands.js";

/** Settle a promise or report that it is still pending after a macrotask. */
async function settledOrPending<T>(
  promise: Promise<T>,
): Promise<{ pending: true } | { pending: false; value: T }> {
  const marker = Symbol("pending");
  const raced = await Promise.race([
    promise.catch(() => marker),
    new Promise<typeof marker>((resolve) => setTimeout(() => resolve(marker), 25)),
  ]);
  if (raced === marker) return { pending: true };
  return { pending: false, value: raced as T };
}

type ListenerOf<D> = D extends CommandDeclaration<infer P, infer R>
  ? CommandListener<P, R>
  : never;

describe("declaration and registration", () => {
  it("declares the four shell keys with the stated policies", () => {
    expect(NotifyCommand.key).toBe("shell:notify");
    expect(NotifyCommand.policy).toEqual({
      onNoHandlers: "reject",
      onAllObserveOnly: "wait",
    }); // async
    expect(OpenDialogCommand.key).toBe("shell:dialog:open");
    expect(OpenDialogCommand.policy).toEqual({
      onNoHandlers: "reject",
      onAllObserveOnly: "reject",
    }); // required
    expect(OpenViewCommand.key).toBe("shell:view:open");
    expect(OpenViewCommand.policy).toEqual({
      onNoHandlers: "reject",
      onAllObserveOnly: "reject",
    }); // required
    expect(ShowPaletteCommand.key).toBe("shell:palette:show");
    expect(ShowPaletteCommand.policy).toEqual({
      onNoHandlers: "wait",
      onAllObserveOnly: "wait",
    }); // silent
  });

  it("exports the four together as `shellCommands`", () => {
    expect(shellCommands).toHaveLength(4);
    expect(getRegistry(newShellContext()).get("shell:notify")).toBe(
      NotifyCommand,
    );
  });

  it("registration executes no application code — the registry is a catalogue", () => {
    const registry = getRegistry(newShellContext());
    // Four declarations are listed, and nothing has been invoked: dispatching
    // any of them right now fails for want of a handler.
    expect(registry.list()).toHaveLength(4);
    const commands = getCommands(newShellContext());
    return expect(
      commands.call(NotifyCommand, { message: "x" }).promise,
    ).rejects.toMatchObject({ kind: "no-handlers" });
  });
});

describe("dispatch", () => {
  it("an async listener claims and settles", async () => {
    const shell = newShellContext();
    const commands = getCommands(shell);
    commands.listen(NotifyCommand, async (cmd) => {
      expect(cmd.payload.message).toBe("saved");
      return { id: "n-1" };
    });
    const result = await commands.call(NotifyCommand, { message: "saved" })
      .promise;
    expect(result).toEqual({ id: "n-1" });
  });

  it("a listener may claim now and settle later via cmd.resolve — the dialog form", async () => {
    const shell = newShellContext();
    const commands = getCommands(shell);
    let settle: (() => void) | undefined;
    commands.listen(OpenDialogCommand, (cmd) => {
      settle = () => cmd.resolve({ outcome: "submitted", data: { name: "a" } });
      return true; // claim now
    });
    const cmd = commands.call(OpenDialogCommand, {
      title: "Rename",
      surface: { root: "TextField" },
    });
    expect(await settledOrPending(cmd.promise)).toEqual({ pending: true });
    settle?.();
    expect(await cmd.promise).toEqual({
      outcome: "submitted",
      data: { name: "a" },
    });
  });

  it("validates the payload at the bus boundary", async () => {
    const commands = getCommands(newShellContext());
    commands.listen(NotifyCommand, async () => ({ id: "n" }));
    const bad = commands.call(NotifyCommand, {
      message: 42,
    } as unknown as { message: string });
    await expect(bad.promise).rejects.toBeInstanceOf(CommandError);
    await expect(bad.promise).rejects.toMatchObject({
      kind: "input-validation",
    });
  });

  it("a `required` command with no handler rejects", async () => {
    const commands = getCommands(newShellContext());
    await expect(
      commands.call(OpenViewCommand, { viewId: "notes.outline" }).promise,
    ).rejects.toMatchObject({ kind: "no-handlers" });
  });

  it("a `required` command with only observers rejects", async () => {
    const commands = getCommands(newShellContext());
    commands.listen(OpenViewCommand, () => {
      /* observe only */
    });
    await expect(
      commands.call(OpenViewCommand, { viewId: "notes.outline" }).promise,
    ).rejects.toMatchObject({ kind: "not-claimed" });
  });

  it("apps dispatch on the shell's bus — one bus, late binding by string key", async () => {
    const shell = newShellContext();
    const a = newAppContext(shell, { id: "a", origin: "https://a.example/" });
    const b = newAppContext(shell, { id: "b", origin: "https://b.example/" });
    getCommands(b).listen(OpenViewCommand, async () => ({ opened: true }));
    expect(
      await getCommands(a).call(OpenViewCommand, { viewId: "b.outline" })
        .promise,
    ).toEqual({ opened: true });
  });
});

describe("substrate defect 1 — a plain synchronous return does not claim", () => {
  it("under `async` policy the call never settles, with no error and no warning", async () => {
    const commands = getCommands(newShellContext());
    // Only a literal `true` or a thenable claims. TypeScript catches this —
    // the listener type is `void | true | Promise<R>` — so the cast below is
    // what it takes to reproduce the trap at all.
    const looksLikeAHandler = (() => ({
      id: "n-1",
    })) as unknown as ListenerOf<typeof NotifyCommand>;
    commands.listen(NotifyCommand, looksLikeAHandler);

    const cmd = commands.call(NotifyCommand, { message: "hello" });
    expect(await settledOrPending(cmd.promise)).toEqual({ pending: true });
    expect(cmd.settled).toBe(false);
  });

  it("making the same listener async fixes it", async () => {
    const commands = getCommands(newShellContext());
    commands.listen(NotifyCommand, async () => ({ id: "n-1" }));
    expect(await commands.call(NotifyCommand, { message: "hello" }).promise)
      .toEqual({ id: "n-1" });
  });
});

describe("substrate defect 2 — `.default()` inverts its own purpose", () => {
  it("every optional field is `.optional()`, so a caller may omit it", async () => {
    const commands = getCommands(newShellContext());
    const seen = vi.fn();
    commands.listen(NotifyCommand, async (cmd) => {
      seen(cmd.payload);
      // Defaults are applied here, in the handler — never in the schema.
      const severity = cmd.payload.severity ?? "info";
      return { id: `${severity}-1` };
    });
    // `severity` and `timeoutMs` are omitted, and this typechecks. Had they
    // carried `.default()`, `StandardSchemaV1<P, P>` would have made them
    // required for the *caller*.
    const out = await commands.call(NotifyCommand, { message: "hi" }).promise;
    expect(out).toEqual({ id: "info-1" });
    expect(seen).toHaveBeenCalledWith({ message: "hi" });
  });

  it("the derived JSON Schema marks only `message` as required", async () => {
    const schema = await NotifyCommand.inputJsonSchema;
    expect(schema.required).toEqual(["message"]);
  });
});

describe("`silent` policy with no handler stays pending by design", () => {
  it("does not reject — guard with Promise.race", async () => {
    const commands = getCommands(newShellContext());
    const cmd = commands.call(ShowPaletteCommand, {});
    expect(await settledOrPending(cmd.promise)).toEqual({ pending: true });
  });

  it("settles once something claims it", async () => {
    const commands = getCommands(newShellContext());
    commands.listen(ShowPaletteCommand, async () => ({ invoked: null }));
    expect(await commands.call(ShowPaletteCommand, { filter: "op" }).promise)
      .toEqual({ invoked: null });
  });
});
