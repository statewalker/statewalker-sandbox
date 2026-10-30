/**
 * 12 — Does PeerShare plug into the suite through slots and commands only?
 */

import type { FetchHandler } from "@statewalker/webrun-http-proxy";
import { describe, expect, it } from "vitest";
import { AddService, ListServices, type ServiceDraft, ToggleService } from "../src/commands.js";
import { sharerMountSlot, upstreamKindsSlot } from "../src/extension-points.js";
import { peershareFeature } from "../src/feature.js";
import { type AppMenuItem, appViewsSlot, createRuntime, menuItemsSlot } from "../src/suite.js";

/** What the suite's slots currently hold. */
function contents(rt: ReturnType<typeof createRuntime>) {
  let items: readonly AppMenuItem[] = [];
  let views: ReadonlyMap<string, unknown> = new Map();
  rt.slots.observe(menuItemsSlot, (v) => {
    items = v;
  })();
  rt.slots.observe(appViewsSlot, (v) => {
    views = v;
  })();
  return { items, views };
}

describe("12 — contributing", () => {
  it("every menu item PeerShare contributes names a command PeerShare handles", () => {
    const rt = createRuntime();
    peershareFeature().contribute(rt);

    const { items } = contents(rt);
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) expect(rt.handled.get(item.command), item.command).toBeDefined();
  });

  it("registers its views in their zones: Services left, Viewer centre, Guests right", () => {
    const rt = createRuntime();
    peershareFeature().contribute(rt);

    const { views } = contents(rt);
    const zones = Object.fromEntries(
      [...views].map(([id, v]) => [id, (v as { zone: string }).zone]),
    );
    expect(zones).toEqual({
      "peershare-services": "left",
      "peershare-viewer": "center",
      "peershare-guests": "right",
    });
  });

  it("disposing leaves nothing behind: no views, no menu items, no handled commands", () => {
    const rt = createRuntime();
    const dispose = peershareFeature().contribute(rt);
    dispose();

    const { items, views } = contents(rt);
    expect(items).toEqual([]);
    expect(views.size).toBe(0);
    expect(rt.handled.list()).toEqual([]);
  });
});

describe("12 — commands drive PeerShare", () => {
  it("add-service applies the kind's own rule: the v1 policy for the built-in kinds", async () => {
    const rt = createRuntime();
    peershareFeature().contribute(rt);
    const add = (draft: ServiceDraft) => rt.commands.call(AddService, draft).promise;

    expect(
      await add({ name: "foo", kind: "bridged", target: "http://localhost:5173" }),
    ).toMatchObject({ ok: true });
    expect(await add({ name: "api", kind: "direct", target: "http://api.example.com" })).toEqual({
      ok: false,
      reason: "needs-https",
    });
    expect(await add({ name: "x", kind: "carrier-pigeon", target: "coo://" })).toEqual({
      ok: false,
      reason: "unknown-kind",
    });
    expect(await rt.commands.call(ListServices, undefined).promise).toEqual([
      { id: "foo", name: "foo", isDefault: true, paused: false },
    ]);
  });

  it("toggle-service pauses a Service in the catalog", async () => {
    const rt = createRuntime();
    peershareFeature().contribute(rt);
    const added = await rt.commands.call(AddService, {
      name: "foo",
      kind: "bridged",
      target: "http://localhost:5173",
    }).promise;
    if (!added.ok) throw new Error("not added");

    await rt.commands.call(ToggleService, { id: added.id, enabled: false }).promise;

    expect((await rt.commands.call(ListServices, undefined).promise)[0]).toMatchObject({
      paused: true,
    });
  });
});

describe("12 — another Feature extends PeerShare", () => {
  it("a third upstream kind, registered by another Feature, serves Guests through PeerShare's mount", async () => {
    const rt = createRuntime();
    peershareFeature().contribute(rt);
    // Another Feature: share in-memory notes, no HTTP service at all.
    const notes: Record<string, string> = { "/hello.txt": "hi from a note" };
    rt.slots.register(upstreamKindsSlot, "notes", {
      id: "notes",
      label: "Notes",
      check: (target) =>
        target.startsWith("notes:") ? { ok: true } : { ok: false, reason: "not-a-url" },
      create: () => async (request) => {
        const body = notes[new URL(request.url).pathname];
        return body == null ? new Response("no note", { status: 404 }) : new Response(body);
      },
    });

    const added = await rt.commands.call(AddService, {
      name: "Notes",
      kind: "notes",
      target: "notes:all",
    }).promise;
    if (!added.ok) throw new Error(`not added: ${added.reason}`);

    // What the mesh host (yet another Feature) mounts at `/s`.
    const mounts: FetchHandler[] = [];
    rt.slots.observe(sharerMountSlot, (v) => mounts.splice(0, mounts.length, ...v))();
    const res = await (mounts[0] as FetchHandler)(
      new Request(`http://sharer.mesh/s/${added.id}/hello.txt`),
    );
    expect(await res.text()).toBe("hi from a note");
  });
});
