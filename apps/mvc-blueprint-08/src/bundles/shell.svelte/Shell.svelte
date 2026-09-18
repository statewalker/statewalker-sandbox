<script lang="ts">
import {
  dialogsSlot,
  headerSlot,
  type MenuContribution,
  menuSlot,
  notificationsSlot,
  panelsSlot,
} from "@b/shell/api";
import { svelteRenderersSlot } from "@b/shell/api/svelte";
import { byOrder } from "@kit/slots";
import HeaderItem from "./HeaderItem.svelte";
import MenuItem from "./MenuItem.svelte";
import Rendered from "./Rendered.svelte";
import { focusReturn, type Slots, slotStore } from "./slots.js";
import Toast from "./Toast.svelte";

let { slots }: { slots: Slots } = $props();
const header = $derived(slotStore(slots, headerSlot));
const menu = $derived(slotStore(slots, menuSlot));
const panels = $derived(slotStore(slots, panelsSlot));
const dialogs = $derived(slotStore(slots, dialogsSlot));
const notifications = $derived(slotStore(slots, notificationsSlot));
const renderers = $derived(slotStore(slots, svelteRenderersSlot));

const groups = $derived.by(() => {
  const byGroup = new Map<string, { label: string; items: MenuContribution[] }>();
  for (const item of byOrder($menu)) {
    const g = byGroup.get(item.group) ?? { label: item.groupLabel, items: [] };
    g.items.push(item);
    byGroup.set(item.group, g);
  }
  return [...byGroup].sort(([a], [b]) => a.localeCompare(b));
});

let picked = $state<string | undefined>();
const entries = $derived([...$panels]);
const main = $derived(
  entries
    .map(([id, p], index) => ({ id, p, index }))
    .filter(({ p }) => p.placement === "main")
    .sort((a, b) => (a.p.order ?? 0) - (b.p.order ?? 0) || a.index - b.index),
);
const side = $derived(
  entries
    .filter(([, p]) => p.placement === "side")
    .sort(([, a], [, b]) => (a.order ?? 0) - (b.order ?? 0)),
);
const active = $derived(main.some((m) => m.id === picked) ? picked : main[0]?.id);
</script>

<div class="flex min-h-screen flex-col">
  <div class="flex items-center gap-4 border-b px-4 py-2">
    <nav aria-label="Main menu" class="flex gap-2">
      {#each groups as [group, { label, items }] (group)}
        <details data-menu-group={group} class="relative">
          <summary class="cursor-pointer px-2">{label}</summary>
          <div role="menu" aria-label={label} class="absolute z-10 flex flex-col border bg-white">
            {#each items as item (item.id)}<MenuItem {item} />{/each}
          </div>
        </details>
      {/each}
    </nav>
    <header data-shell="header" class="ml-auto flex gap-4 text-sm">
      {#each byOrder($header) as item (item.id)}<HeaderItem {item} />{/each}
    </header>
  </div>

  <div class="grid flex-1 grid-cols-1 gap-4 p-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
    <main>
      <div role="tablist" aria-label="Panels" class="mb-2 flex gap-2 border-b">
        {#each main as { id, p } (id)}
          <button
            type="button"
            role="tab"
            aria-selected={id === active}
            class="px-3 py-1 aria-selected:border-b-2"
            onclick={() => (picked = id)}>{p.title}</button>
        {/each}
      </div>
      {#each main as { id, p } (id)}
        <!-- svelte-ignore a11y_no_noninteractive_element_to_interactive_role -->
        <section role="tabpanel" data-panel={id} aria-label={p.title} hidden={id !== active}>
          <Rendered contribution={p} renderers={$renderers} />
        </section>
      {/each}
    </main>
    <aside class="flex flex-col gap-4">
      {#each side as [id, p] (id)}
        <section data-panel={id} aria-label={p.title} class="rounded border p-3">
          <h2 class="mb-2 font-semibold">{p.title}</h2>
          <Rendered contribution={p} renderers={$renderers} />
        </section>
      {/each}
    </aside>
  </div>

  {#each [...$dialogs] as [id, d], index (id)}
    <div
      use:focusReturn
      class="fixed inset-0 flex items-center justify-center bg-black/30"
      style:z-index={50 + index}
    >
      <div role="dialog" aria-modal="true" aria-label={d.title} data-dialog={id} class="rounded bg-white p-4 shadow">
        <h2 class="mb-2 font-semibold">{d.title}</h2>
        <Rendered contribution={d} renderers={$renderers} />
      </div>
    </div>
  {/each}

  <div data-shell="notifications" class="fixed right-4 bottom-4 flex flex-col gap-2">
    {#each $notifications as item (item.id)}<Toast {item} />{/each}
  </div>
</div>
