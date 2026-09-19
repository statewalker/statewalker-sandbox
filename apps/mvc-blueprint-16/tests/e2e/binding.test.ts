import type { Contact, ContactDetailsView } from "@b/contacts/api";
import { contactDetailsKind } from "@b/contacts/api";
import { panelsSlot } from "@b/shell/api";
import { type ApplicationManifest, type Controller, getSlots, type Listener } from "@kernel";
import { describe, expect, it } from "vitest";
import { type Technology, technologies } from "../../src/features/tech.js";
import { contactsSpecs } from "../../src/features/ui.js";
import { open, waitFor } from "./dom.js";

/**
 * U1's binding probe, through the interpreters: the real `contacts:details` SPEC, interpreted by
 * each technology, over an instrumented, hand-rolled model. Counts subscribes, reads and DOM mutations: how each
 * technology's reactivity meets the contract, and what happens when a model breaks point 3 (a no-op
 * notification) or point 7 (a fresh snapshot on every read).
 */
function probe(unstable: boolean) {
  const listeners = new Set<Listener>();
  /** `fields`: property reads on snapshots — how much template work a notification caused. */
  const stats = { reads: 0, fields: 0, subscribes: 0, unsubscribes: 0 };
  const counted = (c: Contact): Contact =>
    Object.freeze(
      Object.defineProperties(
        {},
        Object.fromEntries(
          Object.entries(c).map(([k, v]) => [
            k,
            {
              enumerable: true,
              get: () => {
                stats.fields++;
                return v;
              },
            },
          ]),
        ),
      ) as Contact,
    );
  let plain: Contact = { id: "c1", name: "Ada", email: "ada@x", phone: "1" };
  let value = counted(plain);
  const model: ContactDetailsView = {
    getContact: () => {
      stats.reads++;
      return unstable ? counted(plain) : value;
    },
    onContactUpdate(listener) {
      stats.subscribes++;
      listeners.add(listener);
      listener();
      return () => {
        if (listeners.delete(listener)) stats.unsubscribes++;
      };
    },
  };
  const notify = () => {
    for (const l of [...listeners]) l();
  };
  return {
    stats,
    listeners,
    model,
    notify,
    set(patch: Partial<Contact>) {
      plain = { ...plain, ...patch };
      value = counted(plain);
      notify();
    },
  };
}

type Probe = ReturnType<typeof probe>;

/** The benchmark's shell, interpreter and Contacts specs; the probe stands in for Contacts' logic. */
function probeApp(
  tech: Technology,
  p: Probe,
): { manifest: ApplicationManifest; withdraw: () => void } {
  const ui = technologies[tech];
  let withdraw = () => {};
  const activator: Controller = async (context) => {
    withdraw = getSlots(context).register(panelsSlot, "probe", {
      kind: contactDetailsKind,
      title: "Probe",
      placement: "main",
      model: p.model,
    });
    return () => withdraw();
  };
  return {
    manifest: {
      id: `probe.${tech}`,
      features: [
        ui.shell,
        ui.interpreter,
        { id: "contacts", bundles: [{ id: "probe", activator }] },
        contactsSpecs,
      ],
    },
    withdraw: () => withdraw(),
  };
}

/** Both write the DOM inside the notification: nothing to flush. */
const flush: Record<Technology, () => Promise<void>> = {
  dom: async () => {},
  solid: async () => {},
};

describe.each(["dom", "solid"] as const)("binding probe through the %s interpreter", (tech) => {
  it.each([
    ["stable", false],
    ["unstable", true],
  ] as const)("%s snapshots", async (label, unstable) => {
    const p = probe(unstable);
    const { manifest, withdraw } = probeApp(tech, p);
    const page = await open(manifest);
    const details = () => page.root.querySelector("[data-contact-details]");
    await waitFor(() => details()?.textContent?.includes("ada@x") === true);
    const subs = p.stats.subscribes;
    const readsAtMount = p.stats.reads;
    // Exactly one subscription per mounted group, whatever the technology.
    expect(subs).toBe(1);

    // Ten notifications that change nothing (a model breaking point 3).
    const observer = new MutationObserver(() => {});
    observer.observe(page.root, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
    });
    const before = p.stats.reads;
    const fieldsBefore = p.stats.fields;
    for (let i = 0; i < 10; i++) {
      p.notify();
      await flush[tech]();
    }
    const noopReads = p.stats.reads - before;
    const noopFields = p.stats.fields - fieldsBefore;
    const mutations = observer.takeRecords().length;
    observer.disconnect();

    // One real change: read, rendered.
    const beforeChange = p.stats.reads;
    p.set({ email: "ada@y" });
    await flush[tech]();
    expect(details()?.textContent).toContain("ada@y");
    const changeReads = p.stats.reads - beforeChange;

    withdraw();
    await flush[tech]();
    await waitFor(() => details() === null);
    // Withdrawal unsubscribes: nothing left listening.
    expect(p.listeners.size).toBe(0);
    console.info(
      `[binding] ${tech} ${label} subscribes=${subs} reads@mount=${readsAtMount} reads/10-no-op=${noopReads} field-reads/10-no-op=${noopFields} mutations/10-no-op=${mutations} reads/change=${changeReads} unsubscribes=${p.stats.unsubscribes}`,
    );
    expect(mutations).toBe(0);
    // A stable snapshot makes a no-op notification free in every binding (point 7 does the dedupe).
    if (!unstable) expect(noopFields).toBe(0);
    await page.stop();
  });
});
