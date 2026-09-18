/**
 * The React shell host. Every region is a selector over the store: header = select(shellHeader),
 * panels = select(shellPanels), … Kinds are paired with renderers from `ui.react:renderers`;
 * a panel or dialog whose renderer has not arrived is listed in the coverage report.
 */
import { type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Dispatch } from "../../kernel/index.ts";
import {
  type Dialog,
  type MenuItem,
  type Panel,
  shellDialogs,
  shellHeader,
  shellMenu,
  shellNotifications,
  shellPanels,
} from "../shell/api/index.ts";
import { type ReactRenderer, reactRenderers } from "../shell/api/react.ts";
import { usePoint, useStore } from "./binding.ts";

const byOrder = <T extends { order?: number; id: string }>(a: T, b: T) =>
  (a.order ?? 0) - (b.order ?? 0) || a.id.localeCompare(b.id);

function useRenderers(): Map<string, ReactRenderer> {
  const list = usePoint(reactRenderers);
  return useMemo(() => new Map(list.map((r) => [r.kind.id, r])), [list]);
}

function View({
  item,
  renderers,
  dispatch,
}: {
  item: Panel | Dialog;
  renderers: Map<string, ReactRenderer>;
  dispatch: Dispatch;
}) {
  const renderer = renderers.get(item.kind.id);
  if (!renderer) return <p data-missing-renderer={item.kind.id}>No renderer for {item.kind.id}</p>;
  const Component = renderer.component;
  return <Component props={item.props} dispatch={dispatch} />;
}

function Menu({ items, dispatch }: { items: readonly MenuItem[]; dispatch: Dispatch }) {
  const groups = new Map<string, { label: string; items: MenuItem[] }>();
  for (const item of [...items].sort(byOrder)) {
    const g = groups.get(item.group) ?? { label: item.groupLabel, items: [] };
    g.items.push(item);
    groups.set(item.group, g);
  }
  const sorted = [...groups.entries()].sort(([, a], [, b]) => a.label.localeCompare(b.label));
  return (
    <nav aria-label="Main menu" className="flex gap-4">
      {sorted.map(([id, g]) => (
        <details key={id} className="relative" data-menu-group={id}>
          <summary className="cursor-pointer select-none px-2 py-1 rounded hover:bg-accent">
            {g.label}
          </summary>
          <div
            role="menu"
            aria-label={g.label}
            className="absolute z-10 mt-1 flex min-w-48 flex-col rounded border bg-popover p-1 shadow"
          >
            {g.items.map((m) => (
              <button
                key={m.id}
                type="button"
                role="menuitem"
                disabled={!m.enabled}
                className="rounded px-2 py-1 text-left hover:bg-accent disabled:opacity-50"
                onClick={(e) => {
                  (e.currentTarget.closest("details") as HTMLDetailsElement).open = false;
                  dispatch(m.msg);
                }}
              >
                {m.label}
              </button>
            ))}
          </div>
        </details>
      ))}
    </nav>
  );
}

function Dialogs({
  dialogs,
  renderers,
  dispatch,
}: {
  dialogs: readonly Dialog[];
  renderers: Map<string, ReactRenderer>;
  dispatch: Dispatch;
}) {
  const top = dialogs[dialogs.length - 1];
  const ref = useRef<HTMLDivElement>(null);
  const returnTo = useRef<Element | null>(null);
  // The trigger may be disabled by the very state that opens the dialog, so remember the last
  // focus outside any dialog rather than reading activeElement when the dialog appears.
  const lastOutside = useRef<Element | null>(null);
  useEffect(() => {
    const onFocus = (e: FocusEvent) => {
      if (!(e.target as Element).closest?.("[role=dialog]"))
        lastOutside.current = e.target as Element;
    };
    document.addEventListener("focusin", onFocus);
    return () => document.removeEventListener("focusin", onFocus);
  }, []);
  // Read during render, i.e. before this commit disables the trigger (headless pages get no focusin).
  if (top && !returnTo.current) returnTo.current = lastOutside.current ?? document.activeElement;
  const topId = top?.id;
  useLayoutEffect(() => {
    if (!topId) return;
    ref.current?.querySelector<HTMLElement>("input, button:not([disabled])")?.focus();
    return () => {
      // Withdrawn: give focus back to where it was before the first dialog opened.
      queueMicrotask(() => {
        if (!document.querySelector("[role=dialog]")) {
          (returnTo.current as HTMLElement | null)?.focus?.();
          returnTo.current = null;
        }
      });
    };
  }, [topId]);
  if (!top) return null;
  return (
    <div className="fixed inset-0 z-20 flex items-center justify-center bg-black/30">
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={top.title}
        className="min-w-80 rounded border bg-background p-4 shadow-lg"
      >
        <h2 className="mb-2 font-semibold">{top.title}</h2>
        <View item={top} renderers={renderers} dispatch={dispatch} />
      </div>
    </div>
  );
}

export function ShellHost(): ReactNode {
  const store = useStore();
  const dispatch = store.dispatch;
  const header = [...usePoint(shellHeader)].sort(byOrder);
  const menu = usePoint(shellMenu);
  const panels = usePoint(shellPanels);
  const dialogs = usePoint(shellDialogs);
  const toasts = usePoint(shellNotifications);
  const renderers = useRenderers();
  const main = panels
    .filter((p) => p.placement === "main")
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const side = panels
    .filter((p) => p.placement === "side")
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const [chosen, setChosen] = useState<string>();
  const active = main.find((p) => p.id === chosen) ?? main[0];
  const missing = [...panels, ...dialogs]
    .filter((p) => !renderers.has(p.kind.id))
    .map((p) => `${p.id} (${p.kind.id})`);
  const [storeCoverage, setStoreCoverage] = useState(store.coverage());
  useEffect(() => store.subscribe(() => setStoreCoverage(store.coverage())), [store]);

  return (
    <div className="flex min-h-screen flex-col">
      <header className="flex items-center gap-6 border-b px-4 py-2">
        <strong>Workbench</strong>
        <Menu items={menu} dispatch={dispatch} />
        <div className="ml-auto flex gap-3" data-region="header">
          {header.map((h) => (
            <span
              key={h.id}
              data-header-item={h.id}
              className={h.tone === "warn" ? "text-destructive" : ""}
            >
              {h.text}
            </span>
          ))}
        </div>
      </header>
      <div className="flex flex-1 gap-4 p-4">
        <main className="flex-1">
          <div role="tablist" className="mb-3 flex gap-2 border-b">
            {main.map((p) => (
              <button
                key={p.id}
                type="button"
                role="tab"
                aria-selected={p.id === active?.id}
                className="px-3 py-1 aria-selected:border-b-2 aria-selected:border-primary"
                onClick={() => setChosen(p.id)}
              >
                {p.title}
              </button>
            ))}
          </div>
          {active && (
            <section role="tabpanel" aria-label={active.title} data-panel={active.id}>
              <View item={active} renderers={renderers} dispatch={dispatch} />
            </section>
          )}
        </main>
        {side.length > 0 && (
          <aside className="flex w-80 flex-col gap-3">
            {side.map((p) => (
              <section
                key={p.id}
                aria-label={p.title}
                data-panel={p.id}
                className="rounded border p-3"
              >
                <h2 className="mb-2 font-semibold">{p.title}</h2>
                <View item={p} renderers={renderers} dispatch={dispatch} />
              </section>
            ))}
          </aside>
        )}
      </div>
      <Dialogs dialogs={dialogs} renderers={renderers} dispatch={dispatch} />
      <ol aria-label="Notifications" className="fixed right-4 bottom-4 z-30 flex flex-col gap-2">
        {toasts.map((t) => (
          <li
            key={t.id}
            role="status"
            data-tone={t.tone}
            className="flex items-center gap-2 rounded border bg-background px-3 py-2 shadow"
          >
            <span>{t.message}</span>
            <button type="button" aria-label="Dismiss" onClick={() => dispatch(t.dismiss)}>
              ×
            </button>
          </li>
        ))}
      </ol>
      <footer className="border-t px-4 py-1 text-xs text-muted-foreground">
        <details>
          <summary>Coverage</summary>
          <pre data-coverage>
            {JSON.stringify({ missingRenderers: missing, ...storeCoverage }, null, 2)}
          </pre>
        </details>
      </footer>
    </div>
  );
}
