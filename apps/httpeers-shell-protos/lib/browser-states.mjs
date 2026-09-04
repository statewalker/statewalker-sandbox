import puppeteer from "puppeteer-core";
import chromium from "@sparticuz/chromium";
import { writeFileSync } from "node:fs";

/**
 * BROWSER STATE HARNESS.  Run with: npm run test:browser
 *
 * Verifies the theme bridge in states unit tests cannot reach: dark mode,
 * drag-and-drop overlays, and floating groups.
 *
 * WHY THIS EXISTS. The bridge shipped in rung 7b passed 61 unit tests and
 * did not work: Dockview applies its theme class to an inner `.dv-shell`,
 * so a bridge class on the host was silently overridden. A test that builds
 * its own DOM tests the stylesheet, not the integration.
 *
 * TWO MEASURED FACTS ABOUT DRIVING DOCKVIEW'S DND:
 *
 *  1. Input.dispatchMouseEvent press/move/release does NOT start a drag.
 *     Dockview uses native HTML5 drag-and-drop, and CDP mouse events do not
 *     synthesise it. Zero drop targets appear, no matter how many
 *     intermediate mouseMoved steps are sent. Synthetic
 *     `new DragEvent("dragstart")` from page script also fails: the
 *     DataTransfer carries none of the internal state Dockview needs.
 *
 *  2. page.setDragInterception(true) plus the drag/dragEnter/dragOver/drop
 *     protocol DOES work. GOTCHA: this Puppeteer build requires a
 *     DESTINATION POINT on drag(). `await tab.drag()` throws
 *     "Cannot read properties of undefined (reading 'x')" inside
 *     CdpMouse.drag, with no hint that a coordinate is missing.
 */

const launch = async () =>
  puppeteer.launch({
    args: [...chromium.args, "--no-sandbox"],
    executablePath: await chromium.executablePath(),
    headless: true,
  });

async function open(browser, { dark = false } = {}) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1100, height: 620 });
  await page.goto(`file://${process.cwd()}/dist/states.html`, { waitUntil: "networkidle0" });
  await new Promise((r) => setTimeout(r, 700));
  if (dark) {
    await page.evaluate(() => document.documentElement.classList.add("dark"));
    await new Promise((r) => setTimeout(r, 300));
  }
  return page;
}

/**
 * Drag the first tab onto the last group and measure the overlay.
 *
 * Three elements appear; `.dv-drop-target-selection` is the one that
 * PAINTS. The other two are structural.
 */
async function measureDrag(page) {
  await page.setDragInterception(true);
  const tab = await page.$(".dv-tab");
  const groups = await page.$$(".dv-groupview");
  const target = groups[groups.length - 1];
  const box = await target.boundingBox();

  const data = await tab.drag({ x: box.x + box.width / 2, y: box.y + box.height / 2 });
  await target.dragEnter(data);
  await new Promise((r) => setTimeout(r, 200));
  await target.dragOver(data);
  await new Promise((r) => setTimeout(r, 350));

  const result = await page.evaluate(() => {
    const sel = document.querySelector(".dv-drop-target-selection");
    return {
      dropTargets: document.querySelectorAll("[class*=drop-target]").length,
      selection: sel
        ? {
            bg: getComputedStyle(sel).backgroundColor,
            border: getComputedStyle(sel).borderColor,
          }
        : null,
    };
  });
  await target.drop(data);
  return result;
}

/**
 * Measure the floating group.
 *
 * The shadow is consumed by `.dv-resize-container`, NOT by
 * `.dv-floating-overlay-host` or `.dv-floating-titlebar`. Querying the
 * wrong element produced an earlier false "unproven" verdict in note 35 --
 * a measurement can miss the element that applies a mapping, which looks
 * identical to the mapping not working.
 */
async function measureFloating(page) {
  return page.evaluate(() => {
    const dock = window.__dock;
    const panel = dock.dockview.panels[0];
    dock.dockview.addFloatingGroup(panel.group ?? panel, {
      x: 320, y: 160, width: 340, height: 190,
    });
    const rc = document.querySelector(".dv-resize-container");
    if (!rc) return { found: false };
    const cs = getComputedStyle(rc);
    return {
      found: true,
      boxShadow: cs.boxShadow,
      border: cs.border,
      background: cs.backgroundColor,
    };
  });
}

const browser = await launch();
const results = {};

const light = await open(browser);
results.lightDrag = await measureDrag(light);
results.lightFloating = await measureFloating(light);
await light.screenshot({ path: "dist/state-light.png" });
await light.close();

const dark = await open(browser, { dark: true });
results.darkTokens = await dark.evaluate(() => {
  const shell = document.querySelector(".dv-shell");
  const cs = getComputedStyle(shell);
  return {
    groupBg: cs.getPropertyValue("--dv-group-view-background-color").trim(),
    tabColor: getComputedStyle(document.querySelector(".dv-tab")).color,
  };
});
results.darkDrag = await measureDrag(dark);
await dark.screenshot({ path: "dist/state-dark.png" });
await dark.close();
await browser.close();

writeFileSync("dist/browser-state-results.json", JSON.stringify(results, null, 1));
console.log(JSON.stringify(results, null, 1));

// The overlay colours must CHANGE between light and dark. Asserting the
// FLIP rather than the values is deliberate: if they match, the bridge is
// not reaching the element, which is exactly how the original bug
// presented -- and it presented as "looks fine" in light mode.
const l = results.lightDrag.selection;
const d = results.darkDrag.selection;
if (!l || !d) throw new Error("drop target selection not rendered");
if (l.bg === d.bg) throw new Error(`drag background did not flip: ${l.bg}`);
if (!results.lightFloating.found) throw new Error("floating group not rendered");
if (results.lightFloating.boxShadow === "none") {
  throw new Error("floating box-shadow not applied");
}
console.log("\nAll browser state assertions passed.");
