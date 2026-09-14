import type { ProgressBarView } from "@progress/models";

/** One accessible progress bar, plain DOM and Tailwind. */
export function mountProgressView(container: HTMLElement, model: ProgressBarView): () => void {
  const wrap = document.createElement("div");
  wrap.className = "flex flex-col gap-1 rounded-md border bg-card p-2";
  const label = document.createElement("span");
  label.className = "text-xs text-muted-foreground";
  const track = document.createElement("div");
  track.className = "h-2 w-full overflow-hidden rounded bg-muted";
  track.setAttribute("role", "progressbar");
  track.setAttribute("aria-valuemin", "0");
  track.setAttribute("aria-valuemax", "100");
  const fill = document.createElement("div");
  fill.className = "h-full bg-emerald-600";
  track.append(fill);
  wrap.append(label, track);
  container.append(wrap);
  const off = model.onBarUpdate(() => {
    const { label: text, fraction } = model.getBar();
    const percent = Math.round(fraction * 100);
    label.textContent = text;
    fill.style.width = `${percent}%`;
    track.setAttribute("aria-valuenow", String(percent));
    track.setAttribute("aria-label", text);
  });
  return () => {
    off();
    wrap.remove();
  };
}
