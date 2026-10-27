<script lang="ts">
  import Building2Icon from "@lucide/svelte/icons/building-2";
  import CircleHelpIcon from "@lucide/svelte/icons/circle-help";
  import ShieldCheckIcon from "@lucide/svelte/icons/shield-check";
  import Button from "../lib/kit/components/Button.svelte";
  import AccountEditor from "./AccountEditor.svelte";
  import type { ControlReceipt } from "../lib/api";
  import type { Account, DashboardState } from "../lib/types";

  interface Props {
    dashboard: DashboardState;
    oncontrol?: (action: string, target: string, values: Record<string, unknown>, revision: number) => Promise<ControlReceipt | null> | void;
  }
  let { dashboard, oncontrol = () => undefined }: Props = $props();
  let editing = $state<string | null>(null);
  let adding = $state(false);
  let accountId = $state("");
  let label = $state("");
  let adapter = $state("lightsprint");
  let enabled = $state(true);
  let capacity = $state("12");
  let models = $state("");
  let efforts = $state("low");
  let priority = $state("0");
  let reserve = $state("0");
  let allowUnknownQuota = $state(false);
  let quotaValue = $state("");
  let quotaUnit = $state("credits");
  let quotaExpires = $state("");
  let formError = $state("");

  function begin(account: Account | undefined) {
    formError = "";
    editing = account ? account.id ?? account.server_key ?? "" : "new";
    adding = !account;
    accountId = account ? account.id ?? account.server_key ?? "" : "";
    label = account?.label ?? "";
    adapter = account?.adapter ?? "lightsprint";
    enabled = account?.enabled ?? true;
    capacity = String(account?.capacity ?? 12);
    models = account?.models?.join(", ") ?? "";
    efforts = account?.efforts?.join(", ") ?? "low";
    priority = String(account?.priority ?? 0);
    reserve = String(account?.reserve ?? 0);
    allowUnknownQuota = account?.allow_unknown_quota ?? false;
    quotaValue = account?.quota_override?.value === undefined ? "" : String(account.quota_override.value);
    quotaUnit = account?.quota_override?.unit ?? "credits";
    quotaExpires = account?.quota_override?.expires_at ? new Date(account.quota_override.expires_at * 1000).toISOString().slice(0, 16) : "";
  }

  function list(value: string): string[] {
    return value.split(",").map((item) => item.trim()).filter(Boolean);
  }

  async function save(account: Account | undefined) {
    const id = account ? account.id ?? account.server_key ?? "" : accountId.trim();
    const quota_override = quotaValue.trim()
      ? { value: Number(quotaValue), unit: quotaUnit.trim() || "credits", expires_at: quotaExpires ? Math.floor(new Date(quotaExpires).getTime() / 1000) : null }
      : null;
    const values = {
      label: label.trim(), adapter, enabled, capacity: Number(capacity), models: list(models), efforts: list(efforts),
      priority: Number(priority), reserve: Number(reserve), allow_unknown_quota: allowUnknownQuota, quota_override,
    };
    const invalidQuota = Boolean(quota_override && (!Number.isFinite(quota_override.value) || quota_override.value < 0 || (quotaExpires && !Number.isFinite(quota_override.expires_at))));
    if (!id) formError = "Enter a stable account ID.";
    else if (!values.label) formError = "Enter a display label.";
    else if (!Number.isInteger(values.capacity) || values.capacity < 1 || values.capacity > 100) formError = "Capacity must be a whole number from 1 to 100.";
    else if (adapter === "lightsprint" && values.capacity > 12) formError = "LightSprint capacity above 12 needs backend verification that this account does not report.";
    else if (!Number.isFinite(values.priority) || !Number.isFinite(values.reserve) || values.reserve < 0) formError = "Priority and reserve must be valid numbers; reserve cannot be negative.";
    else if (invalidQuota) formError = "Quota override needs a nonnegative value and a valid expiration.";
    else {
      const receipt = await oncontrol("account-config", id, values, account?.revision ?? 0);
      if (receipt?.state === "confirmed") { editing = null; adding = false; }
    }
  }

  function accountTitle(account: Account, index: number) {
    return account.label ?? account.id ?? account.server_key ?? `Account ${index + 1}`;
  }

  function connectionReason(account: Account): string {
    const observe = account.capabilities?.observe;
    if (observe?.supported) return "Connection test confirms read access only; it does not test launch or execution.";
    return observe?.reason ?? "No verified read-connection capability is reported for this adapter.";
  }
</script>

<section class="page-view providers-view" data-testid="providers-view" aria-labelledby="providers-title">
  <div class="page-heading">
    <div><p class="eyebrow">CONNECTED WORKERS / ACCOUNT MAP</p><h1 id="providers-title">Providers<span class="heading-period">.</span></h1><p class="page-subtitle">Configure public routing policy. Identity, credentials and live credits remain not reported unless the provider reports them.</p></div>
    <div class="provider-summary"><ShieldCheckIcon size={16} aria-hidden="true" /><span>Secrets stay with the local runtime</span></div>
  </div>
  <div class="provider-notice"><CircleHelpIcon size={16} aria-hidden="true" /><p>Never enter API keys, tokens, workspace secrets or backend stack/artifact settings here. Account labels do not prove credential ownership. LightSprint capacity above 12 needs backend verification.</p></div>
  <div class="provider-actions"><Button tone="info" surface="solid" onclick={() => begin(undefined)}>Add account</Button></div>
  {#if adding && editing === "new"}
    <AccountEditor title="Add provider account" adding bind:accountId bind:label bind:adapter bind:enabled bind:capacity bind:models bind:efforts bind:priority bind:reserve bind:allowUnknownQuota bind:quotaValue bind:quotaUnit bind:quotaExpires {formError} oncancel={() => { editing = null; adding = false; }} onsave={() => void save(undefined)} />
  {/if}
  {#if dashboard.accounts.length}
    <div class="provider-list">
      {#each dashboard.accounts as account, index (`${account.id ?? account.server_key}-${index}`)}
        <article class="provider-card">
          <div class="provider-card-heading"><span class="provider-glyph"><Building2Icon size={18} aria-hidden="true" /></span><div><span class="eyebrow">ACCOUNT {String(index + 1).padStart(2, "0")}</span><h2>{accountTitle(account, index)}</h2><p class="mono">{account.identity ?? "Identity not reported"}</p></div><span class:account-enabled={account.enabled} class:account-disabled={account.enabled === false} class="provider-enabled">{account.enabled === false ? "Disabled" : account.enabled === true ? "Enabled" : "State not reported"}</span></div>
          <div class="provider-fields">
            <div class="provider-field"><span class="provider-field-label">Credential status</span><div class="credential-state credential-unknown"><span class="credential-dot credential-dot-unknown"></span>Not reported</div></div>
            <div class="provider-field"><span class="provider-field-label">Configured capacity</span><strong>{account.capacity ?? "Not reported"}{account.capacity === null ? "" : " worker slots"}</strong></div>
            <div class="provider-field"><span class="provider-field-label">Live credits</span><strong>{account.quota?.value ?? "Not reported"}{account.quota?.unit ? ` ${account.quota.unit}` : ""}</strong></div>
            <div class="provider-field"><span class="provider-field-label">Connection health</span><strong>{account.health ?? "Not reported"}</strong></div>
          </div>
          {#if editing === (account.id ?? account.server_key)}
            <AccountEditor title={`Edit ${accountTitle(account, index)}`} bind:accountId bind:label bind:adapter bind:enabled bind:capacity bind:models bind:efforts bind:priority bind:reserve bind:allowUnknownQuota bind:quotaValue bind:quotaUnit bind:quotaExpires {formError} oncancel={() => (editing = null)} onsave={() => void save(account)} />
          {/if}
          <div class="provider-card-footer"><span>Revision {account.revision ?? 0} · no account secret is stored by this form.</span><div><Button size="sm" disabled={!account.capabilities?.observe?.supported} title={connectionReason(account)} onclick={() => oncontrol("account-test", account.id ?? account.server_key ?? "", {}, account.revision ?? 0)}>Test connection</Button><Button size="sm" onclick={() => begin(account)}>Edit account</Button></div></div>
          {#if !account.capabilities?.observe?.supported}<p class="capability-reason">Connection test unavailable: {connectionReason(account)}</p>{/if}
        </article>
      {/each}
    </div>
  {:else if !adding}
    <div class="quiet-state"><span class="quiet-mark">⌁</span><div><strong>No configured provider accounts</strong><p>The service did not report any account labels or capacity.</p></div></div>
  {/if}
</section>
