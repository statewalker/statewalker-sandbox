import { describe, expect, it } from "vitest";
import { workbenchHeadless } from "../../src/apps/index.js";
import { contactId, todosBasics } from "../scenario/scenario.js";
import { start, waitFor } from "../support/headless.js";

describe("dispose", () => {
  it("after the application's cleanup: no actor, no stream value, no listener, no timer, no delivery", async () => {
    const h = await start(workbenchHeadless({ notifyTimeoutMs: 20 }));
    await todosBasics(h); // leaves notifications with pending timers
    await waitFor(() => contactId(h, "Ada Lovelace") !== "");
    h.send("contacts:list", { type: "select", id: contactId(h, "Ada Lovelace") });
    h.dispatch(h.menuAction("Edit contact")); // an open editor
    expect(h.notes().length).toBeGreaterThan(0);
    const system = h.system;

    await h.stop();

    expect(system.addresses()).toEqual([]);
    expect(system.streams.snapshot().filter((s) => s.hasValue || s.owner)).toEqual([]);
    expect(system.streams.snapshot().filter((s) => s.listeners > 0)).toEqual([]);
    const { delivered, turns } = system.stats();
    const dead = system.deadLetters.length;
    await new Promise((r) => setTimeout(r, 60)); // past every notification timeout
    expect(system.stats()).toMatchObject({ delivered, turns });
    expect(system.deadLetters.length).toBe(dead);
    expect(h.errors()).toEqual([]);
  });
});
