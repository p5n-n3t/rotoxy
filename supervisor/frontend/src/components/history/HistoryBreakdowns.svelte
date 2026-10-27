<script lang="ts">
  import type { HistoryBreakdownRow, NativeHistoryReport } from "../../lib/history-types";
  let { report }: { report: NativeHistoryReport } = $props();
  type Section = "accounts" | "models" | "projects" | "tools";
  let active = $state<Section>("accounts");
  const labels: Record<Section, string> = { accounts: "Accounts", models: "Models", projects: "Projects", tools: "Tools" };
  const rows = $derived(report.breakdowns[active] as HistoryBreakdownRow[]);
  const maxEvents = $derived(Math.max(1, ...rows.map((row) => row.event_count ?? 0)));

  function name(row: HistoryBreakdownRow): string { return row.project_id ?? row.id ?? "Not reported"; }
  function attributeCount(row: HistoryBreakdownRow): number {
    return active === "tools" ? (row.tool_call_count ?? 0) : row.usage_count;
  }
</script>

<section class="panel" aria-labelledby="breakdown-heading">
  <div class="panel-heading"><div><p class="eyebrow">ATTRIBUTION / NATIVE EVIDENCE</p><h2 id="breakdown-heading">Where activity comes from</h2></div><span class="panel-note">Rows stay separate by dimension</span></div>
  <div class="tabs" role="tablist" aria-label="History attribution dimension">
    {#each Object.keys(labels) as key (key)}
      <button type="button" role="tab" aria-selected={active === key} class:active={active === key} onclick={() => active = key as Section}>{labels[key as Section]}</button>
    {/each}
  </div>
  {#if rows.length}
    <div class="table-scroll"><table><thead><tr><th scope="col">{labels[active]}</th><th scope="col">Events</th><th scope="col">{active === "tools" ? "Tool calls" : "Usage"}</th><th scope="col">Input / output</th></tr></thead><tbody>
      {#each rows.slice(0, 12) as row (name(row))}
        <tr><th scope="row"><span>{name(row)}</span>{#if row.folder}<small>{row.folder}</small>{/if}<i style:--bar={String(Math.max(.04, row.event_count / maxEvents))}></i></th><td>{row.event_count.toLocaleString()}</td><td>{attributeCount(row).toLocaleString()}</td><td>{row.input_tokens === null ? "Unavailable" : row.input_tokens.toLocaleString()} / {row.output_tokens === null ? "Unavailable" : row.output_tokens.toLocaleString()}</td></tr>
      {/each}
    </tbody></table></div>
    {#if rows.length > 12}<p class="panel-note tail-note">Showing the 12 highest source rows of {rows.length.toLocaleString()}.</p>{/if}
  {:else}<div class="empty-chart">No {labels[active].toLowerCase()} attribution is available.</div>{/if}

  <div class="model-intent"><div><h3>Requested models</h3><p>What Snooze asked the provider to use</p><ul>{#each report.breakdowns.requested_models.slice(0, 5) as row (row.id)}<li><span>{row.id}</span><b>{row.event_count.toLocaleString()}</b></li>{:else}<li class="none">No requested model events</li>{/each}</ul></div>
    <div><h3>Confirmed models</h3><p>What the provider reported using</p><ul>{#each report.breakdowns.confirmed_models.slice(0, 5) as row (row.id)}<li><span>{row.id}</span><b>{row.event_count.toLocaleString()}</b></li>{:else}<li class="none">No confirmed model events</li>{/each}</ul></div></div>
</section>

<style>
  .panel { min-width: 0; padding: 17px 18px 14px; border: 1px solid var(--border-default); border-radius: 9px; background: var(--bg-surface); }.panel-heading { display: flex; align-items: flex-end; justify-content: space-between; gap: 12px; margin-bottom: 12px; }.eyebrow { margin: 0 0 5px; color: var(--text-muted); font-size: 9px; font-weight: 700; letter-spacing: .12em; }h2 { margin: 0; font-size: 14px; font-weight: 610; }.panel-note { color: var(--text-muted); font-size: 9px; }
  .tabs { display: flex; gap: 4px; margin-bottom: 8px; border-bottom: 1px solid var(--border-muted); }.tabs button { padding: 7px 9px; border: 0; border-bottom: 2px solid transparent; color: var(--text-muted); background: transparent; font-size: 10px; cursor: pointer; }.tabs button.active { border-color: var(--accent-cyan); color: var(--text-primary); }
  .table-scroll { overflow-x: auto; }table { width: 100%; border-collapse: collapse; text-align: left; font-size: 9px; }th, td { padding: 8px 6px; border-bottom: 1px solid var(--border-muted); }thead th { color: var(--text-muted); font-size: 8px; font-weight: 600; }tbody th { min-width: 120px; max-width: 175px; position: relative; color: var(--text-primary); font-weight: 580; }tbody th span { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }tbody th small { display: block; overflow: hidden; color: var(--text-muted); font-weight: 400; text-overflow: ellipsis; white-space: nowrap; }tbody th i { position: absolute; right: 6px; bottom: 0; left: 6px; height: 1px; background: var(--accent-cyan); opacity: .55; transform: scaleX(var(--bar)); transform-origin: left; }td { color: var(--text-secondary); font-family: "JetBrains Mono", monospace; white-space: nowrap; }
  .tail-note { margin: 8px 0 0; }.empty-chart { min-height: 90px; display: grid; place-items: center; color: var(--text-muted); font-size: 11px; }.model-intent { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-top: 15px; padding-top: 13px; border-top: 1px solid var(--border-muted); }.model-intent h3 { margin: 0; font-size: 10px; }.model-intent p { margin: 3px 0 7px; color: var(--text-muted); font-size: 9px; }.model-intent ul { display: grid; gap: 4px; margin: 0; padding: 0; list-style: none; }.model-intent li { display: flex; justify-content: space-between; gap: 8px; color: var(--text-secondary); font-size: 9px; }.model-intent li span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }.model-intent li b { color: var(--text-primary); font-family: "JetBrains Mono", monospace; font-weight: 500; }.model-intent li.none { color: var(--text-muted); }
  @media (max-width: 560px) { .panel { padding: 14px 12px 12px; }.panel-heading { align-items: flex-start; flex-direction: column; }.model-intent { grid-template-columns: 1fr; } }
</style>
