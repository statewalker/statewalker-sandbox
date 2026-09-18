/**
 * The React shell host: renders the `shell` actor's point streams, pairs each published view with
 * the renderer for its kind, and forwards view messages. It is the only code that holds a port.
 */
import { type ReactNode, useLayoutEffect, useRef, useState } from "react";
import type { ActionDesc, Contribution, ViewPort, ViewRef } from "../../kernel/index.js";
import { useStream } from "../../kit/react/use-stream.js";
import {
  type Dialog,
  dialogs,
  type HeaderItem,
  header,
  type MenuItem,
  menu,
  type Notification,
  notifications,
  type Panel,
  panels,
} from "../shell/api/index.js";
import { type ReactRenderer, reactRenderers } from "../shell/api/react.js";

const sortBy = <C extends { order?: number }>(list: readonly Contribution<C>[]) =>
  list
    .map((c, i) => ({ c, i }))
    .sort((a, b) => (a.c.value.order ?? 0) - (b.c.value.order ?? 0) || a.i - b.i)
    .map((x) => x.c);

export function Host({ port }: { port: ViewPort }) {
  const headerItems = useStream(port, header.key) ?? [];
  const menuItems = useStream(port, menu.key) ?? [];
  const panelList = useStream(port, panels.key) ?? [];
  const dialogList = useStream(port, dialogs.key) ?? [];
  const notes = useStream(port, notifications.key) ?? [];
  const renderers = useStream(port, reactRenderers.key) ?? [];
  const byKind = new Map(renderers.map((r) => [r.value.kind, r.value]));
  const dispatch = (a: ActionDesc) => {
    if (a.enabled) port.send(a.to, a.msg);
  };
  const main = sortBy(panelList.filter((p) => p.value.placement === "main"));
  const side = sortBy(panelList.filter((p) => p.value.placement === "side"));
  return (
    <div className="shell">
      <header className="shell-header" data-shell-header>
        <strong>Workbench</strong>
        <MainMenu items={menuItems} dispatch={dispatch} />
        {sortBy(headerItems).map((h) => (
          <HeaderText key={h.id} id={h.id} item={h.value} />
        ))}
      </header>
      <div className="shell-body">
        <Tabs
          panels={main}
          render={(p) => (
            <ViewHost
              port={port}
              view={p.value}
              renderer={byKind.get(p.value.kind)}
              dispatch={dispatch}
            />
          )}
        />
        <aside className="shell-side">
          {side.map((p) => (
            <section key={p.id} data-panel={p.id} aria-label={p.value.title} className="panel">
              <h2>{p.value.title}</h2>
              <ViewHost
                port={port}
                view={p.value}
                renderer={byKind.get(p.value.kind)}
                dispatch={dispatch}
              />
            </section>
          ))}
        </aside>
      </div>
      {dialogList.map((d) => (
        <DialogFrame key={d.id} dialog={d}>
          <ViewHost
            port={port}
            view={d.value}
            renderer={byKind.get(d.value.kind)}
            dispatch={dispatch}
          />
        </DialogFrame>
      ))}
      <Toasts notes={notes} dispatch={dispatch} />
    </div>
  );
}

function HeaderText({ id, item }: { id: string; item: HeaderItem }) {
  return (
    <span data-header-item={id} className={`tone-${item.tone ?? "info"}`}>
      {item.text}
    </span>
  );
}

function MainMenu({
  items,
  dispatch,
}: {
  items: readonly Contribution<MenuItem>[];
  dispatch(a: ActionDesc): void;
}) {
  const groups = new Map<string, { label: string; items: Contribution<MenuItem>[] }>();
  for (const i of items) {
    const g = groups.get(i.value.group) ?? { label: i.value.groupLabel, items: [] };
    g.items.push(i);
    groups.set(i.value.group, g);
  }
  return (
    <nav aria-label="Main menu" className="main-menu">
      {[...groups].map(([group, g]) => (
        <details key={group} data-menu-group={group}>
          <summary>{g.label}</summary>
          <div role="menu" aria-label={g.label}>
            {sortBy(g.items).map((i) => (
              <button
                key={i.id}
                type="button"
                role="menuitem"
                disabled={!i.value.action.enabled}
                onClick={() => dispatch(i.value.action)}
              >
                {i.value.action.label}
              </button>
            ))}
          </div>
        </details>
      ))}
    </nav>
  );
}

function Tabs({
  panels: list,
  render,
}: {
  panels: Contribution<Panel>[];
  render(p: Contribution<Panel>): ReactNode;
}) {
  const [active, setActive] = useState<string | undefined>();
  const current = list.find((p) => p.id === active) ?? list[0];
  return (
    <main className="shell-main">
      <div role="tablist">
        {list.map((p) => (
          <button
            key={p.id}
            type="button"
            role="tab"
            aria-selected={p === current}
            onClick={() => setActive(p.id)}
          >
            {p.value.title}
          </button>
        ))}
      </div>
      {current && (
        <div role="tabpanel" data-panel={current.id} aria-label={current.value.title}>
          {render(current)}
        </div>
      )}
    </main>
  );
}

function ViewHost({
  port,
  view,
  renderer,
  dispatch,
}: {
  port: ViewPort;
  view: ViewRef;
  renderer?: ReactRenderer;
  dispatch(a: ActionDesc): void;
}) {
  const state = useStream(port, view.stream);
  if (!renderer) return <p data-unrendered={view.kind}>No renderer for “{view.kind}”.</p>;
  if (state === undefined) return null;
  const Component = renderer.component;
  return (
    <Component
      state={state}
      send={(msg: unknown) => port.send(view.inbox, msg)}
      dispatch={dispatch}
    />
  );
}

function DialogFrame({ dialog, children }: { dialog: Contribution<Dialog>; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  // Captured while rendering, before the dialog exists: what had focus when it was published.
  const [before] = useState(() => document.activeElement as HTMLElement | null);
  useLayoutEffect(() => {
    ref.current?.focus();
    return () => before?.focus?.();
  }, [before]);
  return (
    <div className="dialog-backdrop">
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={dialog.value.title}
        data-dialog={dialog.id}
        tabIndex={-1}
        className="dialog"
      >
        <h2>{dialog.value.title}</h2>
        {children}
      </div>
    </div>
  );
}

function Toasts({
  notes,
  dispatch,
}: {
  notes: readonly Contribution<Notification>[];
  dispatch(a: ActionDesc): void;
}) {
  return (
    <div className="toasts">
      {notes.map((n) => (
        <div key={n.id} data-notification={n.id} className={`toast tone-${n.value.tone}`}>
          <span role={n.value.tone === "error" ? "alert" : "status"}>{n.value.message}</span>
          <button type="button" onClick={() => dispatch(n.value.dismiss)}>
            Dismiss
          </button>
        </div>
      ))}
    </div>
  );
}
