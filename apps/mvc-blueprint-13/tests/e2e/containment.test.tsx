import { type CoverageReport, headerSlot, panelsSlot, shellCoverage } from "@p5/shell/api";
import { reactRenderersSlot } from "@p5/shell/api/react";
import { solidRenderersSlot } from "@p5/shell/api/solid";
import {
  type ApplicationManifest,
  type Controller,
  defineViewKind,
  getSlots,
  type Listener,
} from "@p5/kernel";
import { reactRenderer, useModel as useReactModel } from "@p5/kit-react";
import { solidRenderer } from "@p5/kit-solid";
import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { workbenchReact } from "../../src/apps/react.js";
import { workbenchSolid } from "../../src/apps/solid.js";
import { open, type Page, waitFor } from "./dom.js";
import { q } from "./scenarios.js";

/**
 * W1 — fault containment (OSGi's defining property: a broken bundle does not take the platform
 * down). A third feature contributes (I1) a panel whose renderer throws on first render, and (R1)
 * a panel whose model breaks contract point 7 (a getter returning a new object per call), plus a
 * header item whose model throws. The bad contributions fail ALONE: every other app renders, the
 * failure is shown in place, logged, and listed in `shell:coverage` as `failed`.
 */
interface Probe {
  getState(): { readonly text: string };
  onStateUpdate(listener: Listener): () => void;
}
const throwingKind = defineViewKind<Probe>("bad:throws");
const unstableKind = defineViewKind<Probe>("bad:unstable");
const unstable: Probe = {
  getState: function getState() {
    return { text: "fresh every call" }; // breaks contract point 7
  },
  onStateUpdate: (l) => (l(), () => {}),
};
const badHeader = {
  getState: (): { text: string } => {
    throw new Error("header model bug");
  },
  onStateUpdate: (l: Listener) => (l(), () => {}),
};

const technologies = {
  react: {
    app: workbenchReact,
    renderers: () => [
      [
        reactRenderersSlot,
        reactRenderer(throwingKind, () => {
          throw new Error("renderer bug");
        }),
      ],
      [
        reactRenderersSlot,
        reactRenderer(unstableKind, ({ model }) =>
          createElement("p", null, useReactModel(model.getState, model.onStateUpdate).text),
        ),
      ],
    ],
  },
  solid: {
    app: workbenchSolid,
    renderers: () => [
      [
        solidRenderersSlot,
        solidRenderer(throwingKind, () => {
          throw new Error("renderer bug");
        }),
      ],
    ],
  },
} as const;

function withBadFeature(tech: keyof typeof technologies): ApplicationManifest {
  const t = technologies[tech];
  const bad: Controller = async (context, scope) => {
    const slots = getSlots(context);
    for (const [slot, r] of t.renderers())
      scope.defer(slots.register(slot as never, (r as { kind: { id: string } }).kind.id, r));
    scope.defer(
      slots.register(panelsSlot, "bad:panel", {
        kind: throwingKind,
        title: "Bad",
        placement: "side",
        model: unstable,
      }),
    );
    if (tech === "react")
      scope.defer(
        slots.register(panelsSlot, "bad:unstable", {
          kind: unstableKind,
          title: "Unstable",
          placement: "side",
          model: unstable,
        }),
      );
    scope.defer(slots.provide(headerSlot, { id: "bad:header", order: 99, model: badHeader }));
  };
  return {
    ...t.app,
    features: [...t.app.features, { id: "bad", bundles: [{ id: "bad", activator: bad }] }],
  };
}

describe.each(["react", "solid"] as const)("fault containment: %s (W1)", (tech) => {
  let page: Page | undefined;
  afterEach(async () => {
    await page?.stop();
    page = undefined;
  });

  it("I1/R1: the bad contributions fail alone; Todos, Contacts and the menu still render", async () => {
    page = await open(withBadFeature(tech));
    const $ = q(page);
    await waitFor(() => $.todoTitles().length === 3);
    expect($.panel("contacts:list")?.textContent).toContain("Ada Lovelace");
    expect(page.root.querySelectorAll("[data-menu-group]").length).toBeGreaterThanOrEqual(3);
    const failedIds = () =>
      [...page!.root.querySelectorAll("[data-failed]")].map((e) => e.getAttribute("data-failed"));
    const expected =
      tech === "react" ? ["bad:header", "bad:panel", "bad:unstable"] : ["bad:header", "bad:panel"];
    await waitFor(() => failedIds().length === expected.length);
    expect(failedIds().sort()).toEqual(expected);
    const report: CoverageReport = shellCoverage.get(page.context).getReport();
    expect(report.failed.map((f) => f.id).sort()).toEqual(expected);
    const logged = page.errors().map((c) => JSON.stringify((c as { args: unknown }).args));
    expect(logged.some((l) => l.includes("renderer bug"))).toBe(true);
    expect(logged.some((l) => l.includes("header model bug"))).toBe(true);
    if (tech === "react") {
      // R1: the dev guard names the getter before React's update-depth loop starts.
      const r1 = report.failed.find((f) => f.id === "bad:unstable");
      expect(r1?.error).toMatch(/getState returns a new value on every call/);
    }
  });
});
