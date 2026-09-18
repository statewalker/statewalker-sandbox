<script lang="ts">
import type { TodoListView } from "@b/todos/api";
import { ActionBar, modelStore } from "@kit/svelte";

let { model }: { model: TodoListView } = $props();
const items = $derived(modelStore(model.getItems, model.onItemsUpdate));
const selection = $derived(modelStore(model.getSelection, model.onSelectionUpdate));
const newTitle = $derived(modelStore(model.getNewTitle, model.onNewTitleUpdate));
const toolbar = $derived(modelStore(model.getToolbar, model.onToolbarUpdate));
const selectionActions = $derived(
  modelStore(model.getSelectionActions, model.onSelectionActionsUpdate),
);
const outcome = $derived(modelStore(model.getOutcome, model.onOutcomeUpdate));

function rowClick(e: MouseEvent, id: string) {
  const sel = $selection;
  model.select(
    e.ctrlKey || e.metaKey ? (sel.includes(id) ? sel.filter((x) => x !== id) : [...sel, id]) : [id],
  );
}
</script>

<div class="flex flex-col gap-3">
  <div class="flex gap-2">
    <input
      aria-label="New todo"
      class="flex-1 rounded border px-2"
      value={$newTitle}
      oninput={(e) => model.setNewTitle(e.currentTarget.value)}
    />
    <ActionBar items={$toolbar} label="Todo actions" />
  </div>
  <ul aria-label="Todos" class="flex flex-col">
    {#each $items as todo (todo.id)}
      <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
      <li
        data-todo={todo.id}
        aria-current={$selection.includes(todo.id) || undefined}
        class="flex items-center gap-2 px-2 py-1 aria-[current=true]:bg-slate-100"
        onclick={(e) => rowClick(e, todo.id)}
      >
        <input
          type="checkbox"
          aria-label={`Done: ${todo.title}`}
          checked={todo.done}
          onclick={(e) => {
            e.stopPropagation();
            // Controlled: the model decides; the DOM toggled itself already, so put it back.
            e.currentTarget.checked = todo.done;
            model.select([todo.id]);
            model.toggle.submit();
          }}
        />
        <span class={todo.done ? "line-through" : undefined}>{todo.title}</span>
      </li>
    {/each}
  </ul>
  <ActionBar items={$selectionActions} label="Selection actions" />
  {#if $outcome !== undefined}<p role="alert">{$outcome}</p>{/if}
</div>
