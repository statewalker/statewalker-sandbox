/**
 * `watchPageWake`: which page events make the relay supervisor retry now.
 *
 * WHY THESE FOUR. A browser gives a page no chance to keep a socket alive
 * while it is suspended -- a frozen or backgrounded tab, a sleeping laptop,
 * a phone that switched networks -- and its timers are throttled or stopped
 * meanwhile, so the supervisor's own backoff may not fire for minutes.
 * Each of these events is the page learning it is back:
 *   - `online`             -- the network returned;
 *   - `visibilitychange`   -- the tab is visible again (only when visible:
 *                             going hidden is not a reason to dial);
 *   - `pageshow`           -- restored from the back/forward cache, where
 *                             every connection was closed;
 *   - `resume`             -- unfrozen (Page Lifecycle API).
 *
 * Real `EventTarget`s stand in for `window` and `document`, so the listeners
 * being tested are the ones actually registered.
 */
import { describe, expect, it } from "vitest";
import { watchPageWake } from "../src/browser/page-wake.js";

function fakePage() {
  const win = new EventTarget();
  const doc = Object.assign(new EventTarget(), { visibilityState: "hidden" });
  return { win, doc };
}

describe("watchPageWake", () => {
  it.each([
    ["online", "win"],
    ["pageshow", "win"],
    ["resume", "doc"],
  ] as const)("wakes on %s", (type, target) => {
    const page = fakePage();
    let wakes = 0;
    watchPageWake(() => wakes++, page);
    page[target].dispatchEvent(new Event(type));
    expect(wakes).toBe(1);
  });

  it("wakes when the tab becomes visible, not when it is hidden", () => {
    const page = fakePage();
    let wakes = 0;
    watchPageWake(() => wakes++, page);

    page.doc.visibilityState = "hidden";
    page.doc.dispatchEvent(new Event("visibilitychange"));
    expect(wakes).toBe(0);

    page.doc.visibilityState = "visible";
    page.doc.dispatchEvent(new Event("visibilitychange"));
    expect(wakes).toBe(1);
  });

  it("stops waking once unsubscribed", () => {
    const page = fakePage();
    let wakes = 0;
    const unsubscribe = watchPageWake(() => wakes++, page);
    unsubscribe();

    page.doc.visibilityState = "visible";
    page.win.dispatchEvent(new Event("online"));
    page.win.dispatchEvent(new Event("pageshow"));
    page.doc.dispatchEvent(new Event("resume"));
    page.doc.dispatchEvent(new Event("visibilitychange"));
    expect(wakes).toBe(0);
  });
});
