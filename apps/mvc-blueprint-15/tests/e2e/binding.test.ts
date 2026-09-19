import type { Contact, ContactDetailsView } from "@b/contacts/api";
import { contactDetailsKind } from "@b/contacts/api";
import { panelsSlot } from "@b/shell/api";
import { type ApplicationManifest, type Controller, getSlots, type Listener } from "@kernel";
import { describe, expect, it } from "vitest";
import { type Technology, technologies } from "../../src/apps/workbenches.js";
import { contactsJr } from "../../src/features/jr.js";
import { open, waitFor } from "./dom.js";

/**
 * U1's binding probe, through json-render: the `contacts:details` SPEC rendered by each
 * technology's json-render renderer, over the store adapter, over an instrumented hand-rolled
 * model. Counts subscribes, reads and DOM mutations, and field reads — a field read is json-render
 * resolving a `$state` prop, i.e. element work. What happens on a no-op notification (a model
 * breaking point 3), and on a fresh snapshot per read (breaking point 7)?
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

/** The benchmark's shell and Contacts renderers of `tech`; the probe stands in for Contacts' logic. */
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
        ui.renderer,
        { id: "contacts", bundles: [{ id: "probe", activator }] },
        contactsJr,
      ],
    },
    withdraw: () => withdraw(),
  };
}

/** React commits after its scheduler (a macrotask is enough); Solid writes synchronously. */
const flush: Record<Technology, () => Promise<void>> = {
  solid: async () => {},
  react: () => new Promise((r) => setTimeout(r, 0)),
};

describe.each(["react", "solid"] as const)("binding probe through json-render: %s", (tech) => {
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
    // Exactly one subscription per mounted group, whatever the technology: the adapter's.
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
    const fieldsBeforeChange = p.stats.fields;
    p.set({ email: "ada@y" });
    await flush[tech]();
    expect(details()?.textContent).toContain("ada@y");
    const changeReads = p.stats.reads - beforeChange;
    const changeFields = p.stats.fields - fieldsBeforeChange;

    withdraw();
    await flush[tech]();
    await waitFor(() => details() === null);
    // Withdrawal unsubscribes: nothing left listening.
    expect(p.listeners.size).toBe(0);
    console.info(
      `[binding] jr+${tech} ${label} subscribes=${subs} reads@mount=${readsAtMount} reads/10-no-op=${noopReads} field-reads/10-no-op=${noopFields} mutations/10-no-op=${mutations} reads/change=${changeReads} field-reads/change=${changeFields} unsubscribes=${p.stats.unsubscribes}`,
    );
    expect(mutations).toBe(0);
    // A stable snapshot makes a no-op notification free: the adapter does the dedupe (point 7) and
    // notifies no store listener — json-render resolves no prop, renders no element.
    if (!unstable) {
      expect(noopFields).toBe(0);
      expect(noopReads).toBe(10); // the adapter's own re-read, one per notification
    }
    await page.stop();
  });
});
