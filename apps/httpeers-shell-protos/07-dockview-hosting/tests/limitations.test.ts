// DERIVED-FROM-NOTE: 35 §4 (all 61 unit tests passed before and after the bug;
//                            a test that constructs its own DOM tests the
//                            stylesheet, not the integration)
// DERIVED-FROM-NOTE: 35 §5 (synthetic drag events produce no drop target)
// DERIVED-FROM-NOTE: 35 §6 / 36 §6 (colorScheme is read once at construction;
//                                    a live dark-mode toggle does not work)
// DERIVED-FROM-NOTE: 36 §1 (native HTML5 DnD needs drag interception)
// DERIVED-FROM-NOTE: 36 §3 (a MEASUREMENT can miss the element that applies a
//                            mapping — note 35's floating-group verdict was a
//                            wrong selector, not a broken bridge)
//
// The recorded holes, pinned as tests that DOCUMENT current behaviour. None of
// these assert that the behaviour is correct. Several assert that this test
// environment cannot see the thing at all, which is the honest result and the
// reason lib/browser-states.mjs exists.

import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { createShellDock, type ShellDock } from "../../lib/dock.js";
import { installBridge, SHADCN_THEME_CLASS } from "../../lib/theme-bridge.js";
import { dockviewEsmEntry } from "../src/dockview-css.js";

function newHost(): HTMLElement {
  const host = document.createElement("div");
  document.body.appendChild(host);
  return host;
}

function twoPaneDock(host: HTMLElement): ShellDock {
  const dock = createShellDock(host);
  dock.addPane({ id: "a", title: "A", origin: "https://a.example/" });
  dock.addPane({
    id: "b",
    title: "B",
    origin: "https://b.example/",
    position: { referencePanel: "a", direction: "right" },
  });
  dock.dockview.layout(1000, 600);
  return dock;
}

beforeEach(() => {
  document.body.replaceChildren();
  document.head.replaceChildren();
});

describe("LIMITATION: live dark-mode toggling does not work", () => {
  it("changes nothing about the dock when .dark is applied after construction", () => {
    // Recorded as an open hole in note 36 §6. This pins the CURRENT behaviour;
    // it is not an assertion that the behaviour is right.
    const host = newHost();
    const dock = twoPaneDock(host);
    const shell = host.querySelector(".dv-shell") as HTMLElement;
    const before = shell.className;

    document.documentElement.classList.add("dark");

    expect(shell.className).toBe(before);
    expect(host.querySelector(".dv-shell")).toBe(shell);
    // And the shell offers no way to reapply the theme.
    expect(Object.keys(dock)).not.toContain("setTheme");
    expect(Object.keys(dock)).not.toContain("setColorScheme");
  });

  it("but Dockview itself CAN be re-themed after construction", () => {
    // So the hole is a gap in lib/dock.ts, not a Dockview limitation:
    // `updateOptions({ theme })` re-applies the class to `.dv-shell`.
    // Recording the mechanism here so the fix does not have to be rediscovered.
    const host = newHost();
    const dock = twoPaneDock(host);
    dock.dockview.updateOptions({
      theme: { name: "shadcn", className: SHADCN_THEME_CLASS, colorScheme: "dark" },
    });
    const shell = host.querySelector(".dv-shell") as HTMLElement;
    expect(shell.classList.contains(SHADCN_THEME_CLASS)).toBe(true);
    expect(shell.classList.contains("dockview-theme-light")).toBe(false);
  });

  it("finds `colorScheme` is never read by dockview-core 8.2.0 at all", () => {
    // Note 35 §6 recorded "colorScheme is read once at construction". In this
    // version it is weaker than that: every occurrence in the shipped entry is
    // an object-literal key on a bundled theme, and there is no read anywhere.
    // Its own type calls it "useful for adapting panel content colors" — it is
    // advisory metadata that the EMBEDDER must act on.
    const esm = readFileSync(dockviewEsmEntry(), "utf8");
    const occurrences = [...esm.matchAll(/colorScheme/g)].length;
    expect(occurrences).toBeGreaterThan(0);
    const asKey = [...esm.matchAll(/colorScheme\s*:/g)].length;
    expect(asKey).toBe(occurrences);
    expect(esm).not.toMatch(/\.colorScheme\b/);
    expect(esm).not.toMatch(/\[\s*["']colorScheme["']\s*\]/);
  });
});

describe("LIMITATION: happy-dom cannot see whether the styling works", () => {
  it("resolves no CSS custom property from a stylesheet, even a correct one", () => {
    // THIS is why a green suite here means very little about the theme bridge.
    // Note 35 §4: the shipped bridge passed 61 tests asserting "the bridge maps
    // every variable to a token", "variables resolve on an element carrying the
    // class" and "coverage matches Dockview's real CSS" — all true, all
    // useless, because none asked whether the class reaches the element
    // Dockview reads. In happy-dom the second of those cannot even be
    // attempted: nothing resolves.
    installBridge(document);
    const element = document.createElement("div");
    element.classList.add(SHADCN_THEME_CLASS);
    document.body.appendChild(element);
    const value = getComputedStyle(element).getPropertyValue("--dv-group-view-background-color");
    expect(value).toBe("");
  });

  it("computes no box-shadow on the element that consumes it", () => {
    // Note 36 §3: the shadow lands on `.dv-resize-container`, not on
    // `.dv-floating-overlay-host` — note 35 measured the wrong element and
    // wrongly concluded the bridge was broken. The element is reachable here;
    // its computed style is not, so the finding stays browser-only.
    const host = newHost();
    const dock = twoPaneDock(host);
    const panel = dock.dockview.panels[0] as unknown as { group?: unknown };
    dock.dockview.addFloatingGroup((panel.group ?? panel) as never, {
      x: 20,
      y: 20,
      width: 240,
      height: 160,
    });
    const resize = document.querySelector(".dv-resize-container") as HTMLElement;
    expect(resize).not.toBeNull();
    expect(getComputedStyle(resize).boxShadow).toBe("");
  });
});

describe("LIMITATION: drag-and-drop cannot be driven from here", () => {
  it("produces no drop target from synthetic drag events", () => {
    // Notes 35 §5 and 36 §1: Dockview uses native HTML5 drag-and-drop.
    // CDP mouse events do not synthesise it and a hand-built DragEvent carries
    // none of the internal state Dockview needs; only Chrome's drag
    // interception works. So every `--dv-dnd-*`, `--dv-drag-over-*`,
    // `--dv-smart-guides-*` and `--dv-edge-dock-indicator-*` entry in the
    // bridge is UNEXERCISED by this suite.
    const host = newHost();
    twoPaneDock(host);
    const tab = host.querySelector(".dv-tab") as HTMLElement;
    expect(tab).not.toBeNull();
    const groups = host.querySelectorAll(".dv-groupview");
    const target = groups[groups.length - 1] as HTMLElement;

    tab.dispatchEvent(new DragEvent("dragstart", { bubbles: true }));
    target.dispatchEvent(new DragEvent("dragenter", { bubbles: true }));
    target.dispatchEvent(new DragEvent("dragover", { bubbles: true }));

    expect(host.querySelectorAll("[class*=drop-target]")).toHaveLength(0);
    expect(document.querySelectorAll(".dv-drop-target-selection")).toHaveLength(0);
  });
});
