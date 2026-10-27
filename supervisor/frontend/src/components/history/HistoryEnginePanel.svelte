<script lang="ts">
  import Button from "../../lib/kit/components/Button.svelte";
  import type { EngineReport, EngineReportKind, HistoryFilters } from "../../lib/history-types";
  import { getEngineReport } from "../../lib/history-api";

  let { filters }: { filters: HistoryFilters } = $props();
  const kinds: EngineReportKind[] = ["usage_summary", "usage_top_sessions", "analytics_summary", "analytics_heatmap", "analytics_hour_of_week", "analytics_projects", "analytics_tools", "activity_report"];
  const labels: Record<EngineReportKind, string> = {
    usage_summary: "Usage summary", usage_top_sessions: "Usage sessions", analytics_summary: "Analytics summary",
    analytics_heatmap: "Analytics heatmap", analytics_hour_of_week: "Weekday and hour", analytics_projects: "Project activity",
    analytics_tools: "Tool activity", activity_report: "Activity report",
  };
  let expanded = $state(false);
  let selected = $state<EngineReportKind>("usage_summary");
  let report = $state<EngineReport | null>(null);
  let error = $state("");
  let loading = $state(false);
  let requestController: AbortController | null = null;
  let requestId = 0;

  async function load(kind = selected, requestFilters = filters) {
    requestController?.abort();
    const controller = new AbortController();
    requestController = controller;
    const current = ++requestId;
    loading = true;
    error = "";
    report = null;
    try {
      const response = await getEngineReport(kind, requestFilters, controller.signal);
      if (current === requestId) report = response;
    } catch (cause) {
      if (current === requestId && !(cause instanceof DOMException && cause.name === "AbortError")) error = cause instanceof Error ? cause.message : "External report failed.";
    } finally {
      if (current === requestId) loading = false;
    }
  }

  function toggle() {
    expanded = !expanded;
  }
  function selectKind(event: Event) {
    selected = (event.currentTarget as HTMLSelectElement).value as EngineReportKind;
    report = null;
  }

  $effect(() => {
    const isExpanded = expanded;
    const kind = selected;
    const currentFilters = filters;
    if (!isExpanded) return;
    void load(kind, currentFilters);
    return () => requestController?.abort();
  });

  function previewValue(value: unknown): string {
    if (value === null) return "Unavailable";
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
    if (Array.isArray(value)) return value.length.toLocaleString() + " rows";
    if (typeof value === "object") return Object.keys(value).length.toLocaleString() + " fields";
    return "Unavailable";
  }
</script>

<section class="engine-shell" aria-labelledby="engine-heading">
  <div class="engine-intro"><div><p class="eyebrow">OPTIONAL / EXTERNAL SERVICE</p><h2 id="engine-heading">Provider analytics</h2><p>External reports load only when opened. Their values stay separate from Snooze-native totals.</p></div><Button tone="neutral" surface="outline" size="sm" label={expanded ? "Hide external report" : "Load external report"} ariaExpanded={expanded} onclick={toggle} /></div>
  {#if expanded}
    <div class="engine-body">
      <div class="engine-controls"><label>Report kind<select value={selected} onchange={selectKind}>{#each kinds as kind (kind)}<option value={kind}>{labels[kind]}</option>{/each}</select></label><Button tone="neutral" surface="outline" size="sm" label="Refresh source" disabled={loading} onclick={() => load()} /></div>
      {#if loading}<p class="engine-status" role="status">Loading the selected external report…</p>{/if}
      {#if error}<p class="engine-error" role="alert">{error}</p>{/if}
      {#if report}
        {#if report.state === "unavailable"}
          <div class="engine-unavailable"><strong>External data unavailable</strong><span>{report.error_kind === "not_configured" ? "No provider analytics service is configured." : "This source could not return the selected report."}</span><small>Reason: {report.error_kind ?? "not reported"}. Snooze-native totals above are unchanged.</small></div>
        {:else}
          <div class="engine-provenance"><span>Source version</span><strong>{report.source_version ?? "Unavailable"}</strong><span>Coverage</span><strong>{previewValue(report.coverage.state)}</strong>{#if report.source_window}<span>Requested window</span><strong>{String(report.source_window.requested_from_utc ?? "default")} → {String(report.source_window.requested_to_utc ?? "current")}</strong>{/if}</div>
          <div class="engine-values">{#each Object.entries(report.payload).slice(0, 12) as [key, value] (key)}<article><span>{key.replaceAll("_", " ")}</span><strong>{previewValue(value)}</strong></article>{/each}</div>
          <details class="payload-details"><summary>Inspect normalized source values</summary><pre>{JSON.stringify(report.payload, null, 2)}</pre></details>
        {/if}
      {/if}
    </div>
  {/if}
</section>

<style>
  .engine-shell { margin-top: 16px; border: 1px solid var(--border-default); border-radius: 8px; background: var(--bg-surface); }.engine-intro { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 14px 16px; }.eyebrow { margin: 0 0 5px; color: var(--text-muted); font-size: 9px; font-weight: 700; letter-spacing: .12em; }h2 { margin: 0; font-size: 13px; font-weight: 610; }.engine-intro p:not(.eyebrow) { margin: 5px 0 0; color: var(--text-muted); font-size: 9px; line-height: 1.4; }
  .engine-body { padding: 0 16px 14px; border-top: 1px solid var(--border-muted); }.engine-controls { display: flex; justify-content: flex-end; align-items: end; gap: 8px; padding: 11px 0; }.engine-controls label { display: grid; gap: 4px; color: var(--text-muted); font-size: 9px; }.engine-controls select { height: 31px; padding: 0 8px; border: 1px solid var(--border-default); border-radius: 5px; color: var(--text-primary); background: var(--bg-inset); font-size: 10px; }.engine-status, .engine-error { margin: 6px 0; color: var(--text-muted); font-size: 10px; }.engine-error { color: var(--accent-red); }.engine-unavailable { display: grid; gap: 5px; padding: 13px; border: 1px solid var(--border-muted); border-radius: 6px; background: var(--bg-inset); }.engine-unavailable strong { font-size: 11px; }.engine-unavailable span, .engine-unavailable small { color: var(--text-muted); font-size: 9px; }
  .engine-provenance { display: grid; grid-template-columns: 130px 1fr; gap: 6px 10px; margin-bottom: 10px; padding: 10px; border: 1px solid var(--border-muted); border-radius: 6px; background: var(--bg-inset); }.engine-provenance span { color: var(--text-muted); font-size: 9px; }.engine-provenance strong { min-width: 0; overflow-wrap: anywhere; color: var(--text-secondary); font: 9px "JetBrains Mono", monospace; }
  .engine-values { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 7px; }.engine-values article { min-width: 0; display: grid; gap: 7px; padding: 9px; border: 1px solid var(--border-muted); border-radius: 5px; }.engine-values span { color: var(--text-muted); font-size: 9px; text-transform: capitalize; }.engine-values strong { overflow: hidden; color: var(--text-primary); font: 10px "JetBrains Mono", monospace; text-overflow: ellipsis; white-space: nowrap; }
  .payload-details { margin-top: 10px; }.payload-details summary { color: var(--accent-cyan); font-size: 9px; cursor: pointer; }.payload-details pre { max-height: 230px; overflow: auto; padding: 10px; border-radius: 5px; color: var(--text-secondary); background: var(--bg-inset); font: 9px/1.5 "JetBrains Mono", monospace; white-space: pre-wrap; word-break: break-word; }
  @media (max-width: 560px) { .engine-intro { align-items: flex-start; flex-direction: column; }.engine-intro :global(.kit-button) { width: 100%; }.engine-controls { align-items: stretch; flex-direction: column; }.engine-controls select { width: 100%; }.engine-values { grid-template-columns: repeat(2, minmax(0, 1fr)); }.engine-provenance { grid-template-columns: 1fr; gap: 3px; } }
</style>
