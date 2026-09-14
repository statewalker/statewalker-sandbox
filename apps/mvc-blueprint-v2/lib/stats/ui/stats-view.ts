import { BUCKET_SIZES, type StatsView } from "@stats/models";

const LABELS: Record<number, string> = { 10_000: "10 s", 60_000: "1 min", 300_000: "5 min" };
const SVG = "http://www.w3.org/2000/svg";
const WIDTH = 240;
const HEIGHT = 80;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * The statistics panel in plain DOM and Tailwind — no React. It subscribes to
 * each group of its view model and re-renders only that part.
 */
export function mountStatsView(container: HTMLElement, model: StatsView): () => void {
  const card = el(
    "div",
    "flex flex-col gap-3 rounded-xl border bg-card p-4 text-card-foreground shadow-sm",
  );
  const baseline = el("p", "text-xs text-muted-foreground");
  const totals = el("dl", "grid grid-cols-5 gap-2 text-center");
  const cells = new Map<string, HTMLElement>();
  for (const key of ["created", "closed", "reopened", "removed", "open"]) {
    const cell = el("div", "rounded-md bg-muted px-2 py-1");
    const value = el("dd", "text-lg font-semibold tabular-nums");
    value.dataset.stat = key;
    cell.append(el("dt", "text-[10px] uppercase text-muted-foreground", key), value);
    totals.append(cell);
    cells.set(key, value);
  }
  const bucketBar = el("div", "flex gap-1");
  const buttons = BUCKET_SIZES.map((ms) => {
    const b = el("button", "rounded border px-2 py-0.5 text-xs", LABELS[ms]);
    b.type = "button";
    b.dataset.bucket = String(ms);
    b.addEventListener("click", () => model.setBucket(ms));
    bucketBar.append(b);
    return b;
  });
  const chart = document.createElementNS(SVG, "svg");
  chart.setAttribute("viewBox", `0 0 ${WIDTH} ${HEIGHT}`);
  chart.setAttribute("class", "h-24 w-full");
  chart.setAttribute("role", "img");
  chart.setAttribute("aria-label", "Created and closed per time bucket");
  const legend = el("p", "flex gap-3 text-xs text-muted-foreground");
  legend.append(
    el("span", "text-emerald-600", "■ created"),
    el("span", "text-sky-600", "■ closed"),
  );
  card.append(el("h2", "font-semibold", "Statistics"), baseline, totals, bucketBar, chart, legend);
  container.append(card);

  const renderTotals = () => {
    const t = model.getTotals() as unknown as Record<string, number | undefined>;
    for (const [key, cell] of cells) cell.textContent = t[key] === undefined ? "—" : String(t[key]);
  };
  const renderBaseline = () => {
    const b = model.getBaseline();
    baseline.textContent =
      b.status === "known"
        ? `baseline: ${b.total} todos, ${b.done} done`
        : b.status === "unknown"
          ? `baseline unknown — ${b.reason}`
          : "baseline loading…";
  };
  const renderBucket = () => {
    for (const b of buttons) {
      const active = Number(b.dataset.bucket) === model.getBucket();
      b.setAttribute("aria-pressed", String(active));
      b.classList.toggle("bg-primary", active);
      b.classList.toggle("text-primary-foreground", active);
    }
  };
  const renderChart = () => {
    const timeline = model.getTimeline();
    chart.replaceChildren();
    const max = Math.max(1, ...timeline.flatMap((b) => [b.created, b.closed]));
    const slot = WIDTH / Math.max(1, timeline.length);
    const barWidth = slot / 2 - 1;
    timeline.forEach((bucket, i) => {
      const series = [
        ["created", bucket.created, "fill-emerald-500"],
        ["closed", bucket.closed, "fill-sky-500"],
      ] as const;
      series.forEach(([name, value, fill], j) => {
        const height = (value / max) * (HEIGHT - 4);
        const rect = document.createElementNS(SVG, "rect");
        rect.setAttribute("x", String(i * slot + j * (barWidth + 1)));
        rect.setAttribute("y", String(HEIGHT - height));
        rect.setAttribute("width", String(barWidth));
        rect.setAttribute("height", String(height));
        rect.setAttribute("class", fill);
        rect.dataset.series = name;
        rect.dataset.value = String(value);
        chart.append(rect);
      });
    });
  };

  const offs = [
    model.onTotalsUpdate(renderTotals),
    model.onBaselineUpdate(renderBaseline),
    model.onBucketUpdate(renderBucket),
    model.onTimelineUpdate(renderChart),
  ];
  return () => {
    for (const off of offs) off();
    card.remove();
  };
}
