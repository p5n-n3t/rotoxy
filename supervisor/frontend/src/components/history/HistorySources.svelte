<script lang="ts">
  import type { HistoryCoverage, HistorySource } from "../../lib/history-types";
  let { sources, coverage, queryMs }: { sources: HistorySource[]; coverage: HistoryCoverage; queryMs: number } = $props();

  function date(value: number | null): string { return value === null ? "Unavailable" : new Date(value * 1000).toLocaleString(); }
</script>

<section class="panel source-panel" aria-labelledby="sources-heading">
  <div class="panel-heading"><div><p class="eyebrow">COVERAGE / PROVENANCE</p><h2 id="sources-heading">What this report can support</h2></div><span class="query-time">Query {queryMs.toFixed(1)} ms</span></div>
  <div class="coverage-grid">
    <article><span>Native events</span><strong data-state={coverage.native_events.state}>{coverage.native_events.observed?.toLocaleString() ?? "Unavailable"}</strong><small>{coverage.native_events.eligible === null ? "Eligible total not reported" : coverage.native_events.eligible.toLocaleString() + " eligible"}</small></article>
    <article><span>Imported usage</span><strong data-state={coverage.usage.state}>{coverage.usage.observed?.toLocaleString() ?? "Unavailable"}</strong><small>{coverage.usage.completeness ?? "Eligible source coverage not reported"}</small></article>
    <article><span>Capacity snapshots</span><strong data-state={coverage.historical_capacity.state}>{coverage.historical_capacity.observed?.toLocaleString() ?? "Unavailable"}</strong><small>{coverage.historical_capacity.completeness ?? "Eligible snapshot coverage not reported"}</small></article>
  </div>
  {#if coverage.truncated}
    <div class="truncation" role="status"><strong>Report bounded at 10,000 rows.</strong><span>Some source sections are truncated: {Object.entries(coverage.truncation).filter(([, value]) => value).map(([key]) => key).join(", ") || "see source coverage"}.</span></div>
  {/if}
  <div class="source-list"><h3>Source records</h3>
    {#if sources.length}
      {#each sources as source (source.id + ":" + source.version)}
        <article class="source-row"><div class="source-title"><strong>{source.id}</strong><span>{source.version ?? "Version unavailable"}</span></div><div><small>{source.facts.toLocaleString()} facts</small><small>{date(source.window.from)} → {date(source.window.to)}</small></div>
          {#if source.observed_cost_sources.length}<p><b>Reported cost:</b> {source.observed_cost_sources.join(", ")}</p>{/if}
          {#if source.estimated_cost_sources.length}<p><b>Estimated cost:</b> {source.estimated_cost_sources.join(", ")}</p>{/if}
        </article>
      {/each}
    {:else}<p class="empty-source">No imported source metadata is available. Local event evidence is listed separately in coverage.</p>{/if}
  </div>
  <p class="coverage-note">Coverage not reported remains unavailable. An empty source means no imported facts were returned, not proof of zero provider usage.</p>
</section>

<style>
  .panel { min-width: 0; padding: 17px 18px 14px; border: 1px solid var(--border-default); border-radius: 9px; background: var(--bg-surface); }.panel-heading { display: flex; align-items: flex-end; justify-content: space-between; gap: 12px; margin-bottom: 13px; }.eyebrow { margin: 0 0 5px; color: var(--text-muted); font-size: 9px; font-weight: 700; letter-spacing: .12em; }h2 { margin: 0; font-size: 14px; font-weight: 610; }.query-time { color: var(--text-muted); font: 9px "JetBrains Mono", monospace; }
  .coverage-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }.coverage-grid article { min-width: 0; display: grid; gap: 5px; padding: 10px; border: 1px solid var(--border-muted); border-radius: 6px; background: var(--bg-inset); }.coverage-grid span { color: var(--text-muted); font-size: 9px; }.coverage-grid strong { color: var(--text-primary); font: 600 15px "JetBrains Mono", monospace; }.coverage-grid strong[data-state="partial"] { color: var(--accent-amber); }.coverage-grid strong[data-state="unavailable"] { color: var(--text-muted); }.coverage-grid small { min-height: 23px; color: var(--text-muted); font-size: 8px; line-height: 1.4; }
  .truncation { display: grid; gap: 3px; margin-top: 10px; padding: 9px 11px; border-left: 2px solid var(--accent-amber); color: var(--text-secondary); background: color-mix(in srgb, var(--accent-amber) 7%, var(--bg-inset)); font-size: 9px; }.truncation strong { color: var(--accent-amber); }
  .source-list { margin-top: 15px; }.source-list h3 { margin: 0 0 8px; color: var(--text-primary); font-size: 10px; }.source-row { display: grid; grid-template-columns: minmax(100px, .8fr) minmax(160px, 1fr); gap: 6px 12px; padding: 9px 0; border-top: 1px solid var(--border-muted); }.source-title { min-width: 0; display: grid; align-content: start; gap: 3px; }.source-title strong { overflow: hidden; color: var(--text-primary); font-size: 10px; text-overflow: ellipsis; white-space: nowrap; }.source-title span, .source-row small { color: var(--text-muted); font-size: 8px; }.source-row > div:nth-child(2) { display: flex; flex-direction: column; gap: 3px; }.source-row p { grid-column: 1 / -1; margin: 0; color: var(--text-secondary); font-size: 8px; line-height: 1.4; }.source-row p b { color: var(--text-muted); font-weight: 550; }.empty-source, .coverage-note { color: var(--text-muted); font-size: 9px; line-height: 1.45; }.coverage-note { margin: 11px 0 0; }
  @media (max-width: 560px) { .panel { padding: 14px 12px 12px; }.coverage-grid { grid-template-columns: 1fr; }.coverage-grid small { min-height: auto; }.panel-heading { align-items: flex-start; } }
</style>
