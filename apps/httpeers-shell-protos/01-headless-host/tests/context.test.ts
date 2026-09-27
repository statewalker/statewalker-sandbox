// DERIVED-FROM-NOTE: 10-Prototype 1 Functional Description.md §1 (criteria 1
// and 4) and §4; 08-The Prototype Ladder.md §6 (provenance blindness,
// parent-chain inheritance)

import { Commands, CommandsRegistry } from "@statewalker/shared-commands";
import { Slots } from "@statewalker/shared-slots";
import { describe, expect, it } from "vitest";
import { shellCommands } from "../src/commands.js";
import {
  type AppIdentity,
  getApp,
  getCommands,
  getEnablement,
  getRegistry,
  getSlots,
  newAppContext,
  newShellContext,
  setCommands,
} from "../src/context.js";

describe("criterion 1 — a context is passed untyped but accessed typed", () => {
  it("is a plain object, with no class and no required shape", () => {
    const shell = newShellContext();
    expect(Object.getPrototypeOf(shell)).toBe(Object.prototype);
    // Passing it costs nothing: it is structurally `{ [key: string]: unknown }`.
    const opaque: Record<string, unknown> = shell;
    expect(typeof opaque).toBe("object");
  });

  it("hands back the real types through the adapters", () => {
    const shell = newShellContext();
    expect(getCommands(shell)).toBeInstanceOf(Commands);
    expect(getSlots(shell)).toBeInstanceOf(Slots);
    expect(typeof getEnablement(shell).evaluate).toBe("function");
    expect(typeof getRegistry(shell).list).toBe("function");
  });

  it("throws `Adapter not found: {key}` when the adapter is unset", () => {
    const bare = {};
    expect(() => getCommands(bare)).toThrow("Adapter not found: shell:commands");
  });

  it("treats `undefined` as unset — store `null` for present-but-empty", () => {
    const ctx = { "shell:commands": undefined };
    expect(() => getCommands(ctx)).toThrow("Adapter not found: shell:commands");
  });
});

describe("startup — what newShellContext populates", () => {
  it("seeds the registry with the four shell standard-library commands", () => {
    const registry = getRegistry(newShellContext());
    expect(
      registry
        .list()
        .map((d) => d.key)
        .sort(),
    ).toEqual(["shell:dialog:open", "shell:notify", "shell:palette:show", "shell:view:open"]);
    expect(registry.list()).toHaveLength(shellCommands.length);
  });

  it("gives every shell context its own buses", () => {
    expect(getCommands(newShellContext())).not.toBe(getCommands(newShellContext()));
  });
});

describe("parent-chain inheritance", () => {
  const app: AppIdentity = { id: "notes", origin: "https://notes.example/app" };

  it("an app context is `{ parent: shell }`", () => {
    const shell = newShellContext();
    expect(newAppContext(shell, app).parent).toBe(shell);
  });

  it("an app reading shell:commands receives the *same bus instance*", () => {
    const shell = newShellContext();
    const ctx = newAppContext(shell, app);
    expect(getCommands(ctx)).toBe(getCommands(shell));
    expect(getSlots(ctx)).toBe(getSlots(shell));
    expect(getEnablement(ctx)).toBe(getEnablement(shell));
    expect(getRegistry(ctx)).toBe(getRegistry(shell));
  });

  it("inherits through more than one link", () => {
    const shell = newShellContext();
    const ctx = newAppContext(newAppContext(shell, app), {
      id: "nested",
      origin: "https://nested.example/",
    });
    expect(getCommands(ctx)).toBe(getCommands(shell));
  });

  it("identity stays app-local and does not leak upward", () => {
    const shell = newShellContext();
    const ctx = newAppContext(shell, app);
    expect(getApp(ctx)).toBe(app);
    expect(() => getApp(shell)).toThrow("Adapter not found: shell:app");
  });

  it("identity does not leak sideways between sibling apps", () => {
    const shell = newShellContext();
    const a = newAppContext(shell, app);
    const b = newAppContext(shell, { id: "b", origin: "https://b.example/" });
    expect(getApp(a).id).toBe("notes");
    expect(getApp(b).id).toBe("b");
  });

  it("a local override shadows the inherited adapter without mutating the shell", () => {
    const shell = newShellContext();
    const ctx = newAppContext(shell, app);
    const own = Commands.create();
    setCommands(ctx, own);
    expect(getCommands(ctx)).toBe(own);
    expect(getCommands(shell)).not.toBe(own);
  });
});

describe("provenance blindness", () => {
  it("origin is an opaque URL — a remote host and a peer endpoint are the same shape", () => {
    const shell = newShellContext();
    const remote = newAppContext(shell, {
      id: "editor",
      origin: "https://apps.example.com/editor/",
    });
    const peer = newAppContext(shell, {
      id: "editor",
      origin: "http://localhost:7654/peer/12D3KooWabc/editor/",
    });
    // Nothing in the host branches on origin: both contexts resolve the same
    // buses and the same registry by exactly the same code path.
    expect(getCommands(remote)).toBe(getCommands(peer));
    expect(getRegistry(remote)).toBe(getRegistry(peer));
    expect(typeof getApp(remote).origin).toBe("string");
    expect(typeof getApp(peer).origin).toBe("string");
  });
});

describe("criterion 4 — everything runs headless", () => {
  it("builds a shell context with no DOM node anywhere in it", () => {
    const shell = newShellContext();
    for (const value of Object.values(shell)) {
      expect(value instanceof Node).toBe(false);
    }
  });
});

describe("capability filtering and peer namespacing", () => {
  it("`filter` is the capability gate", () => {
    const shell = newShellContext();
    const gated = CommandsRegistry.filter(getRegistry(shell), (d) => d.key !== "shell:dialog:open");
    expect(gated.get("shell:dialog:open")).toBeUndefined();
    expect(gated.get("shell:notify")?.key).toBe("shell:notify");
    expect(gated.list()).toHaveLength(3);
  });

  it("`namespace` is how a peer's commands mount", () => {
    const remote = getRegistry(newShellContext());
    const mounted = CommandsRegistry.namespace(remote, "peer:12D3KooWabc:");
    expect(mounted.list().map((d) => d.key)).toContain("peer:12D3KooWabc:shell:notify");
    expect(mounted.get("shell:notify")).toBeUndefined();
    expect(mounted.get("peer:12D3KooWabc:shell:notify")?.key).toBe("peer:12D3KooWabc:shell:notify");
  });
});
