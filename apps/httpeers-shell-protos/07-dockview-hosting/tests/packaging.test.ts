// DERIVED-FROM-NOTE: 31 §3.1 (Dockview's CSS is embedded in the JS as a string
//                              and is never injected; no .css file in the package)
// DERIVED-FROM-NOTE: 31 §3.2 (the theme object carries a class that must be
//                              applied by hand)
// DERIVED-FROM-NOTE: 35 §2 (root cause: Dockview applies its theme class to an
//                            inner .dv-shell, so a class on the host is
//                            silently overridden)
// DERIVED-FROM-NOTE: 35 §3 (the fix: pass our own theme object)
// DERIVED-FROM-NOTE: ORIGIN.md finding 7
//
// The packaging facts that made rung 7 run in Chromium rather than happy-dom.
// Three of the four are file-level or DOM-structural, so they ARE reachable
// here; the fourth (does the styling actually resolve) is not — see
// limitations.test.ts.

import { readFileSync } from "node:fs";
import { DockviewComponent, themeLight } from "dockview-core";
import { beforeEach, describe, expect, it } from "vitest";
import { createShellDock } from "../../lib/dock.js";
import { SHADCN_THEME_CLASS } from "../../lib/theme-bridge.js";
import {
  dockviewEsmEntry,
  dockviewPackageFiles,
  dockviewStandaloneBundle,
  extractDockviewStylesheet,
} from "../src/dockview-css.js";

/**
 * Captured at import time, BEFORE any test clears the head. If importing
 * dockview-core injected a stylesheet, it would be here.
 */
const HEAD_AT_IMPORT = document.head.innerHTML;

function newHost(): HTMLElement {
  const host = document.createElement("div");
  document.body.appendChild(host);
  return host;
}

beforeEach(() => {
  document.body.replaceChildren();
  document.head.replaceChildren();
});

describe("Dockview ships no stylesheet", () => {
  it("has no .css file anywhere in the package", () => {
    const css = dockviewPackageFiles().filter((f) => f.endsWith(".css"));
    expect(css).toEqual([]);
  });

  it("keeps the stylesheet only as a JS string in the standalone build", () => {
    const standalone = readFileSync(dockviewStandaloneBundle(), "utf8");
    const stylesheet = extractDockviewStylesheet();
    expect(standalone).toContain('s.textContent = ".dv-');
    // ~147 KB, as measured in note 31 §3.1.
    expect(stylesheet.length).toBeGreaterThan(140_000);
  });

  it('does not carry it in the entry `import "dockview-core"` resolves to', () => {
    // This is the file the shell actually loads. It contains none of the
    // stylesheet, so an app importing the package gets zero styling and no
    // error — the failure mode note 31 §3.1 describes.
    const esm = readFileSync(dockviewEsmEntry(), "utf8");
    expect(esm).not.toContain('s.textContent = ".dv-');
    expect(esm).not.toContain(".dv-tabs-and-actions-container {");
  });

  it("injects nothing on import, and nothing on construction", () => {
    expect(HEAD_AT_IMPORT).toBe("");
    const dock = createShellDock(newHost());
    dock.addPane({ id: "p", title: "P", origin: "https://p.example/" });
    expect(document.head.querySelectorAll("style")).toHaveLength(0);
    expect(document.head.querySelectorAll("link[rel=stylesheet]")).toHaveLength(0);
  });
});

describe("where Dockview puts the theme class", () => {
  it("does not put it on the host — it creates an inner .dv-shell", () => {
    // Note 31 §3.2 said the class "must be applied to the host by hand".
    // Note 35 §2 corrected that: Dockview applies it itself, to a `.dv-shell`
    // element it creates INSIDE the host.
    const host = newHost();
    createShellDock(host);
    expect(host.classList.contains(themeLight.className)).toBe(false);
    const shell = host.querySelector(".dv-shell");
    expect(shell).not.toBeNull();
    expect(shell?.classList.contains(themeLight.className)).toBe(true);
  });

  it("makes .dv-shell a NEARER ancestor of pane content than the host", () => {
    // The whole bug in one assertion. CSS variables inherit, so the nearest
    // ancestor that declares one wins: a bridge class on the host sits
    // strictly outside `.dv-shell.dockview-theme-light`, and every bridged
    // variable falls back to Dockview's bundled theme.
    //
    // In light mode this looked correct purely because Dockview's light theme
    // and Basecoat's light palette happen to agree (note 35 §2). The bridge
    // was doing nothing and nobody could tell.
    const host = newHost();
    host.classList.add(SHADCN_THEME_CLASS);
    const dock = createShellDock(host);
    dock.addPane({ id: "p", title: "P", origin: "https://p.example/" });

    const shell = host.querySelector(".dv-shell") as HTMLElement;
    const content = host.querySelector(".dv-content-container") as HTMLElement;
    expect(host.contains(shell)).toBe(true);
    expect(shell.contains(content)).toBe(true);
    expect(shell.classList.contains(themeLight.className)).toBe(true);
    expect(shell.classList.contains(SHADCN_THEME_CLASS)).toBe(false);

    // Walking up from the content, Dockview's class is met before the bridge's.
    const chain: string[] = [];
    for (let el: HTMLElement | null = content; el; el = el.parentElement) {
      if (el.classList.contains(themeLight.className)) chain.push("dockview");
      if (el.classList.contains(SHADCN_THEME_CLASS)) chain.push("bridge");
    }
    expect(chain).toEqual(["dockview", "bridge"]);
  });

  it("puts OUR class on .dv-shell when we pass our own theme object", () => {
    // Note 35 §3: the fix. Dockview themes are plain
    // `{ name, className, colorScheme }` objects, so supplying one makes
    // Dockview apply the bridge class where it reads it.
    const host = newHost();
    const dockview = new DockviewComponent(host, {
      theme: { name: "shadcn", className: SHADCN_THEME_CLASS, colorScheme: "light" },
      createComponent: () => ({
        element: document.createElement("div"),
        init: () => undefined,
      }),
    });
    dockview.addPanel({ id: "p", component: "surface" });
    const shell = host.querySelector(".dv-shell") as HTMLElement;
    expect(shell.classList.contains(SHADCN_THEME_CLASS)).toBe(true);
    expect(shell.classList.contains(themeLight.className)).toBe(false);
  });

  it("PINS A DEFECT: createShellDock hard-codes themeLight, so the bridge is inert", () => {
    // lib/dock.ts passes `themeLight` and exposes no way to change it. An app
    // built on it therefore gets `.dv-shell.dockview-theme-light` no matter
    // what class the host carries — which is exactly the note 35 bug, still
    // present in the consolidated shell-core. The previous test shows the
    // one-line fix; this one records that it has not been applied, so the
    // test turns red when it is.
    const host = newHost();
    host.classList.add(SHADCN_THEME_CLASS);
    const dock = createShellDock(host);
    const shell = host.querySelector(".dv-shell") as HTMLElement;
    expect(shell.classList.contains("dockview-theme-light")).toBe(true);
    expect(shell.classList.contains(SHADCN_THEME_CLASS)).toBe(false);
    expect(Object.keys(dock)).not.toContain("setTheme");
  });
});
