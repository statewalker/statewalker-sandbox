<script lang="ts">
import type { TitleFormView } from "@b/todos/api";
import { ActionButton, modelStore } from "@kit/svelte";

let { model }: { model: TitleFormView } = $props();
const draft = $derived(modelStore(model.getDraft, model.onDraftUpdate));
const status = $derived(modelStore(model.getStatus, model.onStatusUpdate));
</script>

<form
  class="flex flex-col gap-2"
  onsubmit={(e) => {
    e.preventDefault();
    model.save.submit();
  }}
>
  <input
    aria-label="Title"
    class="rounded border px-2"
    value={$draft.title}
    oninput={(e) => model.editField("title", e.currentTarget.value)}
  />
  {#if $status.errors.form}<p role="alert">{$status.errors.form}</p>{/if}
  <div class="flex gap-2">
    <ActionButton action={model.save} />
    <ActionButton action={model.cancel} />
  </div>
</form>
