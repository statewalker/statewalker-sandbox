<script lang="ts">
import type { ContactEditorView } from "@b/contacts/api";
import { ActionButton, modelStore } from "@kit/svelte";

let { model }: { model: ContactEditorView } = $props();
const draft = $derived(modelStore(model.getDraft, model.onDraftUpdate));
const status = $derived(modelStore(model.getStatus, model.onStatusUpdate));
const FIELDS = [
  ["name", "Name"],
  ["email", "Email"],
  ["phone", "Phone"],
] as const;
</script>

<form
  class="flex flex-col gap-2"
  onsubmit={(e) => {
    e.preventDefault();
    model.save.submit();
  }}
>
  {#each FIELDS as [field, label] (field)}
    <input
      aria-label={label}
      class="rounded border px-2"
      value={$draft[field]}
      oninput={(e) => model.editField(field, e.currentTarget.value)}
    />
  {/each}
  {#if $status.errors.form}<p role="alert">{$status.errors.form}</p>{/if}
  <div class="flex gap-2">
    <ActionButton action={model.save} />
    <ActionButton action={model.cancel} />
  </div>
</form>
