import type { Contact, ContactDetailsView } from "@p5/contacts/api";
import { contactDetailsKind } from "@p5/contacts/api";
import { panelsSlot } from "@p5/shell/api";
import { type ApplicationManifest, type Controller, getSlots, type Listener } from "@p5/kernel";
import { describe, expect, it } from "vitest";
import { contactsReact, shellReactFeature } from "../../src/features/react.js";
import { contactsSolid, shellSolidFeature } from "../../src/features/solid.js";
import { open, waitFor } from "./dom.js";

/**
 * The binding under a probe: one real renderer (`contacts:details`) of each technology over an
 * instrumented, hand-rolled model. Counts subscribes, reads and DOM mutations: how each
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

/** The benchmark's shell and Contacts renderers of `tech`; the probe stands in for Contacts' logic. */
type Technology = "react" | "solid";
const technologies = {
  react: { shell: shellReactFeature, contacts: contactsReact },
  solid: { shell: shellSolidFeature, contacts: contactsSolid },
} as const;

function probeApp(
  tech: Technology,
  p: Probe,
): { manifest: ApplicationManifest; withdraw: () => void } {
  const ui = technologies[tech];
  let withdraw = () => {};
  const activator: Controller = async (context, scope) => {
    withdraw = scope.defer(
      getSlots(context).register(panelsSlot, "probe", {
        kind: contactDetailsKind,
        title: "Probe",
        placement: "main",
        model: p.model,
      }),
    );
  };
  return {
    manifest: {
      id: `probe.${tech}`,
      features: [ui.shell, { id: "contacts", bundles: [{ id: "probe", activator }] }, ui.contacts],
    },
    withdraw: () => withdraw(),
  };
}

/** React commits on its scheduler: a turn of the event loop; Solid writes synchronously. */
const flush: Record<Technology, () => Promise<void>> = {
  solid: async () => {},
  react: () => new Promise((r) => setTimeout(r, 0)),
};

describe.each(["react", "solid"] as const)("binding probe: %s", (tech) => {
  // React's useSyncExternalStore does not survive a model that breaks point 7 (a fresh snapshot on
  // every read): it re-renders until "Maximum update depth exceeded". Measured once, then excluded —
  // the contract suite protects a React renderer, and since P5.1 the dev guard in `useModel` names
  // the getter and the host's error boundary contains it (containment.test.tsx, R1).
  it.each(
    tech === "react"
      ? ([["stable", false]] as const)
      : ([
          ["stable", false],
          ["unstable", true],
        ] as const),
  )("%s snapshots", async (label, unstable) => {
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
