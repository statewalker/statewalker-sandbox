import {
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { byOrder, type ViewKind } from "../../kernel/models.js";
import type { KeyedSlotDeclaration, SlotDeclaration, Slots } from "../../kernel/slots.js";
import { ActionButton } from "../../kit/react/action-button.js";
import { useModel } from "../../kit/react/use-model.js";
import {
  dialogsSlot,
  type HeaderItem,
  headerSlot,
  menuSlot,
  type NotificationEntry,
  notificationsSlot,
  panelsSlot,
} from "../shell/api/index.js";
import { reactRenderersSlot } from "../shell/api/react.js";

function useSlot<T>(slots: Slots, slot: SlotDeclaration<T>): readonly T[];
function useSlot<T>(slots: Slots, slot: KeyedSlotDeclaration<T>): ReadonlyMap<string, T>;
function useSlot<T>(
  slots: Slots,
  slot: SlotDeclaration<T> | KeyedSlotDeclaration<T>,
): readonly T[] | ReadonlyMap<string, T> {
  const plain = slot as SlotDeclaration<T>;
  const subscribe = useCallback(
    (onChange: () => void) => slots.observe(plain, () => onChange()),
    [slots, plain],
  );
  const read = useCallback(() => slots.getSnapshot(plain), [slots, plain]);
  return useSyncExternalStore<readonly T[] | ReadonlyMap<string, T>>(subscribe, read, read);
}

function Rendered({
  slots,
  kind,
  model,
}: {
  slots: Slots;
  kind: ViewKind<unknown>;
  model: unknown;
}) {
  const renderers = useSlot(slots, reactRenderersSlot);
  const renderer = renderers.get(kind.id);
  if (!renderer) return <p data-missing-renderer={kind.id}>No renderer for {kind.id}</p>;
  const Component = renderer.component;
  return <Component model={model} />;
}

function HeaderText({ item }: { item: HeaderItem }) {
  const state = useModel(item.model.getState, item.model.onStateUpdate);
  return <span data-tone={state.tone}>{state.text}</span>;
}

function Toast({ entry }: { entry: NotificationEntry }) {
  const state = useModel(entry.model.getState, entry.model.onStateUpdate);
  return (
    <div role="status" data-tone={state.tone}>
      <span>{state.message}</span>
      <button type="button" aria-label="Dismiss" onClick={() => entry.model.dismiss()}>
        ×
      </button>
    </div>
  );
}

function Dialog({ title, children, depth }: { title: string; children: ReactNode; depth: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>("button, input")?.focus();
    return () => previous?.focus?.(); // focus returns on withdrawal
  }, []);
  return (
    <div className="backdrop" style={{ zIndex: 10 + depth }}>
      <div ref={ref} role="dialog" aria-modal="true" aria-label={title}>
        <h2>{title}</h2>
        {children}
      </div>
    </div>
  );
}

/** The React shell host: renders the shell API's extension points; pairs models with renderers. */
export function Host({ slots }: { slots: Slots }) {
  const header = [...useSlot(slots, headerSlot)].sort(byOrder);
  const menu = [...useSlot(slots, menuSlot)].sort(byOrder);
  const panels = [...useSlot(slots, panelsSlot)];
  const dialogs = [...useSlot(slots, dialogsSlot)];
  const toasts = useSlot(slots, notificationsSlot);
  const main = panels
    .filter(([, p]) => p.placement === "main")
    .sort(([, a], [, b]) => (a.order ?? 0) - (b.order ?? 0));
  const side = panels.filter(([, p]) => p.placement === "side");
  const [active, setActive] = useState<string>();
  const current = main.find(([id]) => id === active) ?? main[0];
  const groups = new Map<string, { label: string; items: typeof menu }>();
  for (const item of menu) {
    const group = groups.get(item.group) ?? { label: item.groupLabel, items: [] };
    group.items.push(item);
    groups.set(item.group, group);
  }
  return (
    <div className="shell">
      <header>
        <strong>Workbench</strong>
        {header.map((item) => (
          <HeaderText key={item.id} item={item} />
        ))}
      </header>
      <div role="menubar" aria-label="Main menu" className="menu">
        {[...groups].map(([id, group]) => (
          <fieldset key={id} aria-label={group.label}>
            <legend>{group.label}</legend>
            {group.items.map((item) => (
              <ActionButton key={item.id} action={item.action} role="menuitem" />
            ))}
          </fieldset>
        ))}
      </div>
      <div className="body">
        <main>
          <div role="tablist">
            {main.map(([id, panel]) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={current?.[0] === id}
                onClick={() => setActive(id)}
              >
                {panel.title}
              </button>
            ))}
          </div>
          {current && (
            <section role="tabpanel" aria-label={current[1].title}>
              <Rendered slots={slots} kind={current[1].kind} model={current[1].model} />
            </section>
          )}
        </main>
        <aside aria-label="Side panels">
          {side.map(([id, panel]) => (
            <section key={id} aria-label={panel.title} data-panel={id}>
              <h2>{panel.title}</h2>
              <Rendered slots={slots} kind={panel.kind} model={panel.model} />
            </section>
          ))}
        </aside>
      </div>
      {dialogs.map(([id, dialog], i) => (
        <Dialog key={id} title={dialog.title} depth={i}>
          <Rendered slots={slots} kind={dialog.kind} model={dialog.model} />
        </Dialog>
      ))}
      <div className="toasts" aria-live="polite">
        {toasts.map((entry) => (
          <Toast key={entry.id} entry={entry} />
        ))}
      </div>
    </div>
  );
}
