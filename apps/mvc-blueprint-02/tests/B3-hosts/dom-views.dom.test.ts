import { createProgressBarModel } from "@progress/app";
import { mountProgressView } from "@progress/ui/dom";
import { StatsModel } from "@stats/app";
import { mountStatsView } from "@stats/ui/dom";
import type { RunningOperation } from "@sys";
import { describe, expect, it } from "vitest";

describe("B3 · DOM views", () => {
  it("the stats view renders totals, the baseline, the bucket choice and one bar per series per bucket", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const model = new StatsModel();
    const unmount = mountStatsView(container, model.view);
    const stat = (k: string) => container.querySelector(`[data-stat="${k}"]`)?.textContent;
    expect(stat("open")).toBe("—");
    model.control.publishTotals({ created: 3, closed: 1, reopened: 0, removed: 0, open: 2 });
    expect([stat("created"), stat("closed"), stat("open")]).toEqual(["3", "1", "2"]);
    model.control.publishBaseline({ status: "unknown", reason: "no-handlers" });
    expect(container.textContent).toContain("baseline unknown");
    container.querySelector<HTMLButtonElement>('[data-bucket="60000"]')?.click();
    expect(model.view.getBucket()).toBe(60_000);
    expect(container.querySelector('[data-bucket="60000"]')?.getAttribute("aria-pressed")).toBe(
      "true",
    );
    model.control.publishTimeline(
      Array.from({ length: 12 }, (_, i) => ({
        start: i * 60_000,
        created: i === 11 ? 2 : 0,
        closed: 0,
      })),
    );
    expect(container.querySelectorAll("rect")).toHaveLength(24);
    expect(container.querySelector('rect[data-series="created"][data-value="2"]')).not.toBeNull();
    unmount();
    expect(container.children).toHaveLength(0);
    container.remove();
  });

  it("the progress view renders an accessible bar that follows its model", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    let progress = { label: "Adding 4 sample todos", done: 0, total: 4 };
    const listeners = new Set<() => void>();
    const op: RunningOperation = {
      getProgress: () => progress,
      onProgressUpdate: (l) => {
        listeners.add(l);
        l();
        return () => listeners.delete(l);
      },
    };
    const bar = createProgressBarModel(op);
    const unmount = mountProgressView(container, bar.view);
    const track = container.querySelector('[role="progressbar"]');
    expect(track?.getAttribute("aria-valuenow")).toBe("0");
    progress = { ...progress, done: 2 };
    for (const l of [...listeners]) l();
    expect(track?.getAttribute("aria-valuenow")).toBe("50");
    expect(track?.getAttribute("aria-label")).toBe("Adding 4 sample todos");
    unmount();
    container.remove();
  });
});
