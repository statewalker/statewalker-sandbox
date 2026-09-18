<script lang="ts">
import type { ContactListView } from "@b/contacts/api";
import { ActionBar, modelStore } from "@kit/svelte";

let { model }: { model: ContactListView } = $props();
const contacts = $derived(modelStore(model.getContacts, model.onContactsUpdate));
const selected = $derived(modelStore(model.getSelectedId, model.onSelectedIdUpdate));
const actions = $derived(modelStore(model.getSelectionActions, model.onSelectionActionsUpdate));
</script>

<div class="flex flex-col gap-3">
  <ul aria-label="Contacts" class="flex flex-col">
    {#each $contacts as c (c.id)}
      <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
      <li
        data-contact={c.id}
        aria-current={c.id === $selected || undefined}
        class="cursor-pointer px-2 py-1 aria-[current=true]:bg-slate-100"
        onclick={() => model.select(c.id)}
      >{c.name}</li>
    {/each}
  </ul>
  <ActionBar items={$actions} label="Contact actions" />
</div>
