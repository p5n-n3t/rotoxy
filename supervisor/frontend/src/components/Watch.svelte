<script lang="ts">
  import ActivityIcon from "@lucide/svelte/icons/activity";
  import ArrowUpRightIcon from "@lucide/svelte/icons/arrow-up-right";
  import Clock3Icon from "@lucide/svelte/icons/clock-3";
  import OctagonAlertIcon from "@lucide/svelte/icons/octagon-alert";
  import PauseIcon from "@lucide/svelte/icons/pause";
  import ShieldAlertIcon from "@lucide/svelte/icons/shield-alert";
  import Table from "../lib/kit/components/Table.svelte";
  import TableHeaderCell from "../lib/kit/components/TableHeaderCell.svelte";
  import Button from "../lib/kit/components/Button.svelte";
  import StatusDot from "../lib/kit/components/StatusDot.svelte";
  import { display, formatElapsed, formatTimestamp, statusTone } from "../lib/format";
  import type { DashboardState, InboxPage, Slot } from "../lib/types";

  interface Props {
    dashboard: DashboardState;
    loading: boolean;
    notice: string;
    inbox?: InboxPage | null;
    inboxError?: string;
    oninspect: (taskId: string) => void;
    oncheck: () => void;
    onack: (taskId: string | null, kind: string | null) => void;
    onregister?: (coordinatorId: string) => void;
    onincidentack?: (deliveryId: string, coordinatorId: string) => void;
  }
  let { dashboard, loading, notice, inbox = null, inboxError = "", oninspect, oncheck, onack, onregister = () => undefined, onincidentack = () => undefined }: Props = $props();
  let coordinatorId = $state("snooze-local-ui");

  const groups = $derived.by(() => {
    const byAccount = new Map<string, Slot[]>();
    for (const slot of dashboard.slots) {
      const key = slot.account_id ?? "unassigned";
      byAccount.set(key, [...(byAccount.get(key) ?? []), slot]);
    }
    const known = dashboard.accounts.map((account) => ({
      key: account.server_key ?? account.label ?? "account",
      label: account.label ?? account.server_key ?? "Unlabelled account",
      capacity: account.capacity,
      slots: byAccount.get(account.server_key ?? account.label ?? "account") ?? [],
    }));
    const knownKeys = new Set(dashboard.accounts.map((account) => account.server_key ?? account.label ?? "account"));
    const unknown = Array.from(byAccount.entries())
      .filter(([key]) => !knownKeys.has(key))
      .map(([key, slots]) => ({ key, label: key === "unassigned" ? "Account not attributed" : key, capacity: null, slots }));
    return [...known, ...unknown].filter((group) => group.slots.length > 0 || (group.capacity ?? 0) > 0);
  });
  const dispatchReason = $derived(dashboard.capabilities.dispatch.reason || "Dispatch is not available from this observation-only service.");
</script>

<section class="page-view watch-view" data-testid="watch-view" aria-labelledby="watch-title">
  <div class="page-heading">
    <div>
      <p class="eyebrow">NIGHT SHIFT / LIVE OBSERVATION</p>
      <h1 id="watch-title">Worker watch<span class="heading-period">.</span></h1>
      <p class="page-subtitle">A clear view of who is occupied, what changed, and where attention is needed.</p>
    </div>
    <div class="heading-actions">
      <Button tone="info" surface="solid" size="md" disabled={loading} onclick={oncheck}>
        {#snippet children()}<ActivityIcon size={15} aria-hidden="true" /><span>{loading ? "Checking…" : "Check now"}</span>{/snippet}
      </Button>
    </div>
  </div>

  <div class="watch-strip">
    <div class="watch-stat"><span class="stat-symbol active-symbol"><ActivityIcon size={17} aria-hidden="true" /></span><span class="stat-copy"><strong>{dashboard.summary.active_tasks}</strong><small>Occupied workers</small></span></div>
    <div class="watch-stat"><span class="stat-symbol incident-symbol"><OctagonAlertIcon size={17} aria-hidden="true" /></span><span class="stat-copy"><strong>{dashboard.incidents.length}</strong><small>Open incidents</small></span></div>
    <div class="watch-stat"><span class="stat-symbol time-symbol"><Clock3Icon size={17} aria-hidden="true" /></span><span class="stat-copy"><strong>{dashboard.cycle.checked ? formatTimestamp(dashboard.cycle.checked) : "Not reported"}</strong><small>Last actual check</small></span></div>
    <div class="watch-lights" aria-label="Dispatcher controls">
      <button type="button" class="watch-disabled-action" disabled title={dispatchReason} aria-describedby="dispatch-disabled-reason"><PauseIcon size={14} aria-hidden="true" /> Pause dispatcher</button>
      <button type="button" class="watch-disabled-action emergency" disabled title={dispatchReason} aria-describedby="dispatch-disabled-reason"><ShieldAlertIcon size={14} aria-hidden="true" /> Emergency stop</button>
      <span id="dispatch-disabled-reason" class="sr-only">{dispatchReason}</span>
    </div>
  </div>

  {#if notice}
    <p class="inline-notice" role="status">{notice}</p>
  {/if}

  {#if dashboard.incidents.length}
    <section class="incident-inbox" aria-labelledby="inbox-title">
      <div class="section-heading incident-heading"><div><p class="eyebrow">NEEDS ATTENTION</p><h2 id="inbox-title">Intervention inbox <span class="count-pill">{dashboard.incidents.length}</span></h2></div><span class="inbox-live"><i></i> actionable records</span></div>
      <div class="incident-list">
        {#each dashboard.incidents.slice(0, 8) as incident, index (`${incident.task_id}-${incident.kind}-${index}`)}
          <article class="incident-row">
            <div class="incident-marker"><OctagonAlertIcon size={15} aria-hidden="true" /></div>
            <div class="incident-copy"><strong>{display(incident.kind, "Worker event")}</strong><span>{display(incident.message, "No event detail was recorded.")}</span><small>{display(incident.task_id, "Task not reported")} · {formatTimestamp(incident.at)}</small></div>
            <Button size="sm" onclick={() => onack(incident.task_id, incident.kind)}>Acknowledge</Button>
          </article>
        {/each}
      </div>
      {#if dashboard.incidents.length > 8}<p class="muted footnote">Showing the 8 most recent of {dashboard.incidents.length} incidents. Open History to page through the full record.</p>{/if}
    </section>
  {/if}

  <section class="delivery-inbox" aria-labelledby="delivery-title" data-testid="delivery-inbox">
    <div class="section-heading incident-heading"><div><p class="eyebrow">DURABLE DELIVERY RECEIPTS</p><h2 id="delivery-title">Coordinator inbox</h2></div><span class="inbox-live">{inbox?.deliveries.length ?? 0} receipts</span></div>
    {#if inboxError}<p class="stale-banner" role="status">Delivery inbox unavailable. {inboxError}</p>{/if}
    {#if inbox?.wake_mode === "inbox-only"}<p class="inbox-only-notice">Inbox only: no coordinator wake channel is configured. A stored delivery does not wake an arbitrary ChatGPT window. {inbox.reason}</p>{/if}
    <div class="coordinator-register"><label for="coordinator-id">Local coordinator ID</label><input id="coordinator-id" bind:value={coordinatorId} /><Button size="sm" disabled={!coordinatorId.trim()} onclick={() => onregister(coordinatorId.trim())}>Register coordinator</Button></div>
    {#if inbox?.deliveries.length}
      <div class="incident-list">
        {#each inbox.deliveries as delivery (delivery.id)}
          <article class="incident-row delivery-row">
            <div class="incident-copy"><strong>{String(delivery.payload.kind ?? delivery.state)}</strong><span>{String(delivery.payload.message ?? "No delivery message was recorded.")}</span><small class="mono">{delivery.id} · {delivery.state}{delivery.resolved ? " · resolved" : " · unresolved"}</small></div>
            {#if delivery.acknowledged_at}<span class="ack-state">Acknowledged</span>{:else}<Button size="sm" onclick={() => onincidentack(delivery.id, coordinatorId.trim())} disabled={!coordinatorId.trim()}>Acknowledge delivery</Button>{/if}
          </article>
        {/each}
      </div>
    {:else if !inboxError}<div class="quiet-state inbox-quiet"><div><strong>No durable delivery receipts</strong><p>Incident acknowledgment and resolution are separate records.</p></div></div>{/if}
    <p class="muted footnote">Acknowledgment records receipt only; it does not resolve the incident or claim that a remote worker changed state.</p>
  </section>

  <section class="roster" aria-labelledby="roster-title">
    <div class="section-heading"><div><p class="eyebrow">OCCUPIED CAPACITY</p><h2 id="roster-title">Active roster</h2></div><span class="roster-context">Reservations grouped by configured account</span></div>
    {#if groups.every((group) => group.slots.length === 0)}
      <div class="quiet-state"><span class="quiet-mark">∿</span><div><strong>No occupied slots right now</strong><p>Unused and terminal worker rows stay out of the live roster. Historical records remain in History.</p></div></div>
    {:else}
      {#each groups as group (group.key)}
        <section class="account-block" aria-label={`${group.label} occupied slots`}>
          <header class="account-heading"><span class="account-emblem">{group.label.slice(0, 1).toUpperCase()}</span><div><h3>{group.label}</h3><p>{group.slots.length} occupied <span>·</span> {group.capacity === null ? "capacity not reported" : `${group.capacity} configured slots`}</p></div><span class="account-capacity">{group.slots.length}<i>/</i>{group.capacity ?? "?"}</span></header>
          <div class="mobile-worker-list">
            {#each group.slots as slot, index (slot.task_id ?? `mobile-${group.key}-${index}`)}
              <article class="mobile-worker-card">
                <div class="mobile-worker-top"><span class="slot-badge">{slot.logical_slot ?? index + 1}</span><span class="state-label"><StatusDot status={statusTone(slot.provider_state)} label={display(slot.provider_state)} />{display(slot.provider_state, "Unobserved")}</span></div>
                <strong>{display(slot.task_summary, "Assignment not reported")}</strong><small>{display(slot.workspace_id, "Workspace not reported")}</small>
                <div class="mobile-worker-facts"><span>Model <b>{display(slot.confirmed_model)}</b></span><span>Effort <b>{display(slot.confirmed_effort)}</b></span><span>Requested effort <b>{display(slot.requested_effort)}</b></span><span>Elapsed <b>{formatElapsed(slot.started_at)}</b></span></div>
                <div class="mobile-worker-bottom"><span>Observed {formatTimestamp(slot.observed_at)}</span><button class="inspect-link kit-control-states" type="button" onclick={() => slot.task_id && oninspect(slot.task_id)} disabled={!slot.task_id}>Inspect <ArrowUpRightIcon size={14} aria-hidden="true" /></button></div>
              </article>
            {/each}
          </div>
          <Table ariaLabel={`${group.label} worker roster`} zebra={false} class="roster-table">
            {#snippet header()}<TableHeaderCell label="Slot" /><TableHeaderCell label="Assignment" /><TableHeaderCell label="Model / effort" /><TableHeaderCell label="Elapsed / observed" /><TableHeaderCell label="State" /><TableHeaderCell label="" />{/snippet}
            {#snippet children()}
              {#each group.slots as slot, index (slot.task_id ?? `${group.key}-${index}`)}
                <tr data-testid="watch-row">
                  <td><span class="slot-badge">{slot.logical_slot ?? index + 1}</span></td>
                  <td><div class="assignment-cell"><strong title={display(slot.task_summary, "Assignment not reported")}>{display(slot.task_summary, "Assignment not reported")}</strong><small>{display(slot.workspace_id, "Workspace not reported")}</small></div></td>
                  <td><div class="model-cell"><span>{display(slot.confirmed_model)}</span><small><b data-testid="confirmed-effort">{display(slot.confirmed_effort)}</b>{#if slot.requested_effort && slot.requested_effort !== slot.confirmed_effort}<span class="requested-value" data-testid="requested-effort">Requested {slot.requested_effort}</span>{/if}</small></div></td>
                  <td><div class="time-cell"><span>{formatElapsed(slot.started_at)}</span><small>{formatTimestamp(slot.observed_at)}</small></div></td>
                  <td><span class="state-label"><StatusDot status={statusTone(slot.provider_state)} label={display(slot.provider_state)} />{display(slot.provider_state, "Unobserved")}</span><small class="freshness-label">{display(slot.observation_freshness, "Freshness not reported")}</small></td>
                  <td><button class="inspect-link kit-control-states" type="button" onclick={() => slot.task_id && oninspect(slot.task_id)} disabled={!slot.task_id} aria-label={`Inspect ${display(slot.task_summary, slot.task_id ?? "worker")}`}>Inspect <ArrowUpRightIcon size={14} aria-hidden="true" /></button></td>
                </tr>
              {/each}
            {/snippet}
          </Table>
        </section>
      {/each}
    {/if}
  </section>
</section>
