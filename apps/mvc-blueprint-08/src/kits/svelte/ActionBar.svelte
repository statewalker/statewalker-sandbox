<script lang="ts">
import type { ActionContribution } from "@kernel";
import ActionButton from "./ActionButton.svelte";

/** A list of contributed actions as a toolbar. */
let { items, label }: { items: readonly ActionContribution[]; label: string } = $props();
</script>

<div role="toolbar" aria-label={label} class="flex flex-wrap gap-2">
  {#each items as c (c.id)}
    <ActionButton action={c.action} />
  {/each}
</div>
