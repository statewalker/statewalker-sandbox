<script lang="ts">
import type { ContactDetailsView } from "@b/contacts/api";
import { modelStore } from "@kit/svelte";

let { model }: { model: ContactDetailsView } = $props();
const contact = $derived(modelStore(model.getContact, model.onContactUpdate));
</script>

{#if $contact}
  <dl data-contact-details={$contact.id} class="grid grid-cols-[auto_1fr] gap-x-3">
    <dt>Name</dt>
    <dd>{$contact.name}</dd>
    <dt>Email</dt>
    <dd>{$contact.email}</dd>
    <dt>Phone</dt>
    <dd>{$contact.phone}</dd>
  </dl>
{/if}
