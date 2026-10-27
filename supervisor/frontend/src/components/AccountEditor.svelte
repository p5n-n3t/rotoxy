<script lang="ts">
  import TextInput from "../lib/kit/components/TextInput.svelte";
  import Button from "../lib/kit/components/Button.svelte";
  interface Props {
    title: string; adding?: boolean; accountId: string; label: string; adapter: string; enabled: boolean; capacity: string;
    models: string; efforts: string; priority: string; reserve: string; allowUnknownQuota: boolean; quotaValue: string;
    quotaUnit: string; quotaExpires: string; formError?: string; oncancel: () => void; onsave: () => void;
  }
  let {
    title, adding = false,
    accountId = $bindable(""), label = $bindable(""), adapter = $bindable("lightsprint"), enabled = $bindable(true), capacity = $bindable("12"),
    models = $bindable(""), efforts = $bindable("low"), priority = $bindable("0"), reserve = $bindable("0"),
    allowUnknownQuota = $bindable(false), quotaValue = $bindable(""), quotaUnit = $bindable("credits"), quotaExpires = $bindable(""),
    formError = "", oncancel, onsave,
  }: Props = $props();
</script>

<div class="account-editor" data-testid="account-editor">
  <div class="account-editor-heading"><div><span class="eyebrow">PUBLIC ACCOUNT POLICY</span><h3>{title}</h3></div><button type="button" class="text-button" onclick={oncancel}>Cancel</button></div>
  <div class="account-form-grid">
    {#if adding}<label>Stable account ID<TextInput bind:value={accountId} ariaLabel="Stable account ID" /></label>{/if}
    <label>Display label<TextInput bind:value={label} ariaLabel="Display label" required /></label>
    <label>Adapter<select bind:value={adapter} aria-label="Adapter">{#each ["lightsprint", "local", "native", "ssh", "tailscale", "ollama", "v0", "figma", "external"] as item}<option value={item}>{item}</option>{/each}</select></label>
    <label>Capacity<input type="number" min="1" max={adapter === "lightsprint" ? 12 : 100} bind:value={capacity} aria-label="Capacity" /></label>
    <label>Models<TextInput bind:value={models} ariaLabel="Models" placeholder="model-a, model-b" /></label>
    <label>Efforts<TextInput bind:value={efforts} ariaLabel="Efforts" placeholder="low, medium" /></label>
    <label>Priority<input type="number" bind:value={priority} aria-label="Priority" /></label>
    <label>Quota reserve<input type="number" min="0" step="any" bind:value={reserve} aria-label="Quota reserve" /></label>
    <label>Operator quota override<input type="number" min="0" step="any" bind:value={quotaValue} aria-label="Operator quota override" placeholder="No override" /></label>
    <label>Override unit<TextInput bind:value={quotaUnit} ariaLabel="Override unit" /></label>
    <label>Override expires<input type="datetime-local" bind:value={quotaExpires} aria-label="Override expires" /></label>
    <label class="checkbox-field"><input type="checkbox" bind:checked={allowUnknownQuota} />Allow routing when quota is not reported</label>
    <label class="checkbox-field"><input type="checkbox" bind:checked={enabled} />Account enabled</label>
  </div>
  <p class="form-help">Model and effort values are routing claims, not provider verification. Quota overrides expire at the selected time; no override means quota is not reported unless the service reports it.</p>
  {#if formError}<p class="field-error" role="alert">{formError}</p>{/if}
  <div class="account-editor-footer"><Button tone="info" surface="solid" onclick={onsave}>Save account</Button></div>
</div>
