import type { Contact, ContactDraft } from "@b/contacts/api";
import { describe, expect, it } from "vitest";
import { createActor, fromCallback, fromPromise } from "xstate";
import {
  contactEditorMachine,
  type SessionEvent,
} from "../../src/bundles/contacts.edit.xstate/machine.js";

const ada: Contact = { id: "c1", name: "Ada", email: "ada@x.org", phone: "1" };
const draft: ContactDraft = { name: "Ada L.", email: "ada@x.org", phone: "1" };

/** The machine with stub effects: sessions and saves are recorded, saves settle on demand. */
function harness() {
  const log: string[] = [];
  const saves: { input: unknown; settle: (ok: boolean) => void }[] = [];
  const machine = contactEditorMachine.provide({
    actors: {
      session: fromCallback<SessionEvent, Contact>(({ input, receive }) => {
        log.push(`+session ${input.id}`);
        receive((e) => log.push(e.type === "running" ? `running=${e.value}` : "failed"));
        return () => log.push(`-session ${input.id}`);
      }),
      save: fromPromise<void, { id: string; patch: ContactDraft }>(
        ({ input }) =>
          new Promise<void>((resolve, reject) =>
            saves.push({ input, settle: (ok) => (ok ? resolve() : reject(new Error("nope"))) }),
          ),
      ),
    },
    actions: { saved: () => void log.push("saved") },
  });
  const actor = createActor(machine).start();
  const value = () => JSON.stringify(actor.getSnapshot().value);
  return { actor, log, saves, value };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("contacts.edit XState machine (no DOM, no kernel)", () => {
  it("open → save → failed → save → saved", async () => {
    const { actor, log, saves, value } = harness();
    actor.send({ type: "open", contact: ada });
    expect(value()).toBe('{"open":"editing"}');
    actor.send({ type: "save", draft });
    actor.send({ type: "save", draft }); // refused: no handler in `saving`
    expect(value()).toBe('{"open":"saving"}');
    expect(saves).toHaveLength(1);
    expect(saves[0].input).toEqual({ id: "c1", patch: draft });
    saves[0].settle(false);
    await tick();
    expect(value()).toBe('{"open":"editing"}');
    actor.send({ type: "save", draft });
    saves[1].settle(true);
    await tick();
    expect(value()).toBe('"closed"');
    expect(log).toEqual([
      "+session c1",
      "running=false",
      "running=true",
      "failed",
      "running=false",
      "running=true",
      "saved",
      "-session c1",
    ]);
  });

  it("stopping mid-save stops the session and ignores the late result", async () => {
    const { actor, log, saves } = harness();
    actor.send({ type: "open", contact: ada });
    actor.send({ type: "save", draft });
    actor.stop();
    saves[0].settle(true);
    await tick();
    expect(log).toEqual(["+session c1", "running=false", "running=true", "-session c1"]);
  });

  it("opening another contact replaces the session", () => {
    const { actor, log } = harness();
    actor.send({ type: "open", contact: ada });
    actor.send({ type: "open", contact: { ...ada, id: "c2" } });
    expect(log.filter((l) => l.includes("session"))).toEqual([
      "+session c1",
      "-session c1",
      "+session c2",
    ]);
  });
});
