/** @jsxImportSource solid-js */
import type { FocusReturn } from "@p5/kit-host";
import type { Rendered, ShellHostView } from "@p5/kit-shell";
import { useModel } from "@p5/kit-solid";
import type { HeaderContribution, MenuContribution, NotificationContribution } from "@p5/shell/api";
import { type Component, For, onCleanup, Show } from "solid-js";
import { Dynamic, render } from "solid-js/web";

type Shell = ShellHostView<Component<{ model: never }>>;
type Entry = Rendered<Component<{ model: never }>>;

/**
 * The Solid host: renders the shell-host model. Setup-once components: every subscription is made
 * in a component's setup; `<For>` keys by reference, and the model keeps an entry's identity until
 * its contribution or renderer changes — so a renderer is re-created exactly when its model changes
 * identity (U1's host rule).
 */
export function mountShell(container: HTMLElement, shell: Shell, focus: FocusReturn): () => void {
  return render(() => {
    const groups = useModel(shell.getMenu, shell.onMenuUpdate);
    const header = useModel(shell.getHeader, shell.onHeaderUpdate);
    const main = useModel(shell.getMain, shell.onMainUpdate);
    const side = useModel(shell.getSide, shell.onSideUpdate);
    const active = useModel(shell.getActiveTab, shell.onActiveTabUpdate);
    const dialogs = useModel(shell.getDialogs, shell.onDialogsUpdate);
    const toasts = useModel(shell.getNotifications, shell.onNotificationsUpdate);
    return (
      <div class="flex min-h-screen flex-col">
        <div class="flex items-center gap-4 border-b px-4 py-2">
          <nav aria-label="Main menu" class="flex gap-2">
            <For each={groups()}>
              {(g) => (
                <details data-menu-group={g.group} class="relative">
                  <summary class="cursor-pointer px-2">{g.label}</summary>
                  <div
                    role="menu"
                    aria-label={g.label}
                    class="absolute z-10 flex flex-col border bg-white"
                  >
                    <For each={g.items}>{(item) => <MenuItem item={item} />}</For>
                  </div>
                </details>
              )}
            </For>
          </nav>
          <header data-shell="header" class="ml-auto flex gap-4 text-sm">
            <For each={header()}>{(item) => <HeaderItem item={item} />}</For>
          </header>
        </div>
        <div class="grid flex-1 grid-cols-1 gap-4 p-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
          <main>
            <div role="tablist" aria-label="Panels" class="mb-2 flex gap-2 border-b">
              <For each={main()}>
                {(p) => (
                  <button
                    type="button"
                    role="tab"
                    aria-selected={p.id === active()}
                    class="px-3 py-1 aria-selected:border-b-2"
                    onClick={() => shell.selectTab(p.id)}
                  >
                    {p.contribution.title}
                  </button>
                )}
              </For>
            </div>
            <For each={main()}>
              {(p) => (
                <section
                  role="tabpanel"
                  data-panel={p.id}
                  aria-label={p.contribution.title}
                  hidden={p.id !== active()}
                >
                  <Draw entry={p} />
                </section>
              )}
            </For>
          </main>
          <aside class="flex flex-col gap-4">
            <For each={side()}>
              {(p) => (
                <section
                  data-panel={p.id}
                  aria-label={p.contribution.title}
                  class="rounded border p-3"
                >
                  <h2 class="mb-2 font-semibold">{p.contribution.title}</h2>
                  <Draw entry={p} />
                </section>
              )}
            </For>
          </aside>
        </div>
        <For each={dialogs()}>
          {(d, index) => {
            onCleanup(focus.opened());
            return (
              <div
                class="fixed inset-0 flex items-center justify-center bg-black/30"
                style={{ "z-index": 50 + index() }}
              >
                <div
                  role="dialog"
                  aria-modal="true"
                  aria-label={d.contribution.title}
                  data-dialog={d.id}
                  class="rounded bg-white p-4 shadow"
                >
                  <h2 class="mb-2 font-semibold">{d.contribution.title}</h2>
                  <Draw entry={d} />
                </div>
              </div>
            );
          }}
        </For>
        <div data-shell="notifications" class="fixed right-4 bottom-4 flex flex-col gap-2">
          <For each={toasts()}>{(item) => <Toast item={item} />}</For>
        </div>
      </div>
    );
  }, container);
}

/** The contribution's renderer, or nothing (the coverage report lists the gap). */
function Draw(props: { entry: Entry }) {
  return (
    <Show when={props.entry.component}>
      {(c) => <Dynamic component={c()} model={props.entry.contribution.model as never} />}
    </Show>
  );
}

function HeaderItem(props: { item: HeaderContribution }) {
  const state = useModel(props.item.model.getState, props.item.model.onStateUpdate);
  return <span data-header-item={props.item.id}>{state().text}</span>;
}

function MenuItem(props: { item: MenuContribution }) {
  const state = useModel(props.item.action.getState, props.item.action.onStateUpdate);
  return (
    <button
      type="button"
      role="menuitem"
      class="px-3 py-1 text-left disabled:opacity-50"
      disabled={!state().enabled || state().running}
      onClick={(event) => {
        props.item.action.submit();
        event.currentTarget.closest("details")?.removeAttribute("open");
      }}
    >
      {state().label}
    </button>
  );
}

function Toast(props: { item: NotificationContribution }) {
  const state = useModel(props.item.model.getState, props.item.model.onStateUpdate);
  return (
    <div
      data-notification={props.item.id}
      data-tone={state().tone}
      role={state().tone === "error" ? "alert" : "status"}
      class="flex items-center gap-2 rounded border bg-white px-3 py-2 shadow"
    >
      <span>{state().message}</span>
      <button type="button" aria-label="Dismiss" onClick={() => props.item.model.dismiss()}>
        ×
      </button>
    </div>
  );
}
