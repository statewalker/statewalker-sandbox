<script lang="ts">
import type { ConfirmView } from "@b/todos/api";
import { ActionButton } from "@kit/svelte";

let { model }: { model: ConfirmView } = $props();
</script>

<div class="flex flex-col gap-2">
  <p>{model.getQuestion().text}</p>
  <div class="flex gap-2">
    <ActionButton action={model.confirm} />
    <ActionButton action={model.cancel} />
  </div>
</div>
