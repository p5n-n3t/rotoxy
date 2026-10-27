<script lang="ts">
  import SettingsLayout from "../lib/kit/components/SettingsLayout.svelte";
  import Button from "../lib/kit/components/Button.svelte";
  import type { ControlReceipt } from "../lib/api";
  import type { DashboardState } from "../lib/types";

  interface Props {
    dashboard: DashboardState; saving: boolean; notice: string; onsave: (interval: number) => void;
    onpolicy?: (values: Record<string, unknown>, revision: number) => Promise<ControlReceipt | null> | void;
    oncontrol?: (action: string, target: string, values: Record<string, unknown>, revision: number) => void;
  }
  let { dashboard, saving, notice, onsave, onpolicy = () => undefined, oncontrol = () => undefined }: Props = $props();
  const categories = [
    { id: "monitoring", label: "Monitoring", group: "Service", summary: "Check cadence and freshness" },
    { id: "dispatcher", label: "Dispatch", group: "Service", summary: "Limits, budgets and stop controls" },
    { id: "appearance", label: "Appearance", group: "Workspace", summary: "Theme and motion" },
  ];
  let active = $state("monitoring");
  let interval = $state("");
  let policyLoaded = $state(false);
  let maxConcurrent = $state("12");
  let globalConcurrent = $state("24");
  let maxRecoveries = $state("2");
  let backoff = $state("60");
  let stall = $state("900");
  let observations = $state("4");
  let requestTimeout = $state("20");
  let reserve = $state("0");
  let allowUnknownQuota = $state(false);
  let allowNative = $state(false);
  let nativeCeiling = $state("0");
  let nativeReserve = $state("");
  let mode = $state("balanced");
  let modelLimitsText = $state("");
  let loadedRevision: number | null = null;
  let policyDirty = $state(false);
  $effect(() => {
    const settings = dashboard.settings;
    if (!saving) interval = String(settings.interval ?? 300);
    const currentRevision = settings.revision ?? 0;
    if (loadedRevision === null || (!policyDirty && loadedRevision !== currentRevision)) {
      maxConcurrent = String(settings.max_concurrent ?? 12);
      globalConcurrent = String(settings.global_concurrent ?? 24);
      maxRecoveries = String(settings.max_recoveries ?? 2);
      backoff = String(settings.backoff_seconds ?? 60);
      stall = String(settings.stall_seconds ?? 900);
      observations = String(settings.observation_workers ?? 4);
      requestTimeout = String(settings.request_timeout ?? 20);
      reserve = String(settings.reserve ?? 0);
      allowUnknownQuota = settings.allow_unknown_quota ?? false;
      allowNative = settings.allow_native ?? false;
      nativeCeiling = String(settings.native_ceiling ?? 0);
      nativeReserve = settings.native_reserve == null ? "" : String(settings.native_reserve);
      mode = settings.mode ?? "balanced";
      modelLimitsText = Object.entries(settings.model_limits ?? {}).map(([key, value]) => `${key}: ${value}`).join("\n");
      policyLoaded = true;
      loadedRevision = currentRevision;
    }
  });
  const parsedInterval = $derived(Number(interval));
  const intervalValid = $derived(Number.isInteger(parsedInterval) && parsedInterval >= 30 && parsedInterval <= 86400);
  const revision = $derived(dashboard.settings.revision ?? 0);
  const dispatchCapability = $derived(dashboard.capabilities.pause ?? dashboard.capabilities.dispatch);
  const emergencyCapability = $derived(dashboard.capabilities.emergency_stop ?? dashboard.capabilities.dispatch);
  const maxConcurrentValue = $derived(Number(maxConcurrent));
  const globalConcurrentValue = $derived(Number(globalConcurrent));
  const maxRecoveriesValue = $derived(Number(maxRecoveries));
  const backoffValue = $derived(Number(backoff));
  const reserveValue = $derived(Number(reserve));
  const nativeCeilingValue = $derived(Number(nativeCeiling));
  const nativeReserveValue = $derived(nativeReserve.trim() ? Number(nativeReserve) : null);
  const modelLimits = $derived.by(() => {
    const parsed: Record<string, number> = {};
    for (const line of modelLimitsText.split("\n")) {
      const [rawName, rawLimit, ...extra] = line.split(":");
      if (!rawName?.trim() && !rawLimit?.trim()) continue;
      if (extra.length || !rawName?.trim() || !/^\d+$/.test(rawLimit?.trim() ?? "")) return null;
      parsed[rawName.trim()] = Number(rawLimit.trim());
      if (parsed[rawName.trim()] < 1) return null;
    }
    return parsed;
  });
  const policyValid = $derived(
    Number.isInteger(maxConcurrentValue) && maxConcurrentValue >= 1 &&
    Number.isInteger(globalConcurrentValue) && globalConcurrentValue >= 1 &&
    Number.isInteger(maxRecoveriesValue) && maxRecoveriesValue >= 0 && maxRecoveriesValue <= 2 &&
    Number.isInteger(backoffValue) && backoffValue >= 1 && Number.isFinite(reserveValue) && reserveValue >= 0 &&
    Number.isInteger(Number(stall)) && Number(stall)>=1 && Number(stall)<=86400 &&
    Number.isInteger(Number(observations)) && Number(observations)>=1 && Number(observations)<=8 &&
    Number.isInteger(Number(requestTimeout)) && Number(requestTimeout)>=1 && Number(requestTimeout)<=30 &&
    Number.isInteger(nativeCeilingValue) && nativeCeilingValue >= 0 &&
    (!allowNative || (nativeCeilingValue >= 1 && nativeReserveValue !== null && Number.isFinite(nativeReserveValue) && nativeReserveValue >= 0)) && modelLimits !== null,
  );
  const pauseDispatch = $derived(dashboard.settings.pause_dispatch ?? true);
  const emergencyStopped = $derived(dashboard.settings.emergency_stop ?? false);

  function markPolicyDirty() { if (policyLoaded) mode = "custom"; policyDirty = true; }
  function applyMode(next: string) {
    mode = next;
    policyDirty = true;
    if (next === "conservative") {
      interval = "600"; maxConcurrent = "4"; globalConcurrent = "8"; maxRecoveries = "1"; backoff = "120"; reserve = "100";
      allowUnknownQuota = false; allowNative = false; nativeCeiling = "0"; nativeReserve = ""; modelLimitsText = "";
      observations = "2";
    } else if (next === "balanced") {
      interval = "300"; maxConcurrent = "12"; globalConcurrent = "24"; maxRecoveries = "2"; backoff = "60"; reserve = "0";
      allowUnknownQuota = false; allowNative = false; nativeCeiling = "0"; nativeReserve = ""; modelLimitsText = "";
      observations = "4";
    }
  }
  async function savePolicy() {
    if (!policyValid || !modelLimits) return;
    const receipt = await onpolicy({
      interval: intervalValid ? parsedInterval : dashboard.settings.interval ?? 300,
      max_concurrent: maxConcurrentValue, global_concurrent: globalConcurrentValue,
      max_recoveries: maxRecoveriesValue, backoff_seconds: backoffValue, reserve: reserveValue,
      stall_seconds: Number(stall), observation_workers: Number(observations), request_timeout: Number(requestTimeout),
      allow_unknown_quota: allowUnknownQuota, allow_native: allowNative, native_ceiling: nativeCeilingValue,
      native_reserve: nativeReserveValue, model_limits: modelLimits, mode,
    }, revision);
    if (receipt?.state === "confirmed") policyDirty = false;
  }
</script>

<section class="page-view settings-view" data-testid="settings-view" aria-labelledby="settings-title">
  <div class="page-heading"><div><p class="eyebrow">SERVICE PREFERENCES / LOCAL ONLY</p><h1 id="settings-title">Settings<span class="heading-period">.</span></h1><p class="page-subtitle">Persist safe policy limits without restarting the coordinator.</p></div></div>
  {#if notice}<p class="inline-notice" role="status">{notice}</p>{/if}
  <div class="settings-frame">
    <SettingsLayout {categories} bind:active title="Settings">
      {#snippet panel(category)}
        {#if category === "monitoring"}
          <div class="settings-panel-heading"><p class="eyebrow">SERVICE / MONITORING</p><h2>Check cadence</h2><p>Choose how often Snooze checks worker sources. Monitoring cadence does not change worker-slot capacity.</p></div>
          <div class="settings-group"><div><label for="check-interval">Check interval</label><p>Minimum 30 seconds. The next check time is reported only when the service confirms it.</p></div><div class="interval-control"><input id="check-interval" type="number" min="30" max="86400" step="1" bind:value={interval} /><span>seconds</span><Button tone="info" surface="solid" disabled={!intervalValid || saving} onclick={() => onsave(parsedInterval)}>{saving ? "Saving…" : "Save interval"}</Button></div></div>
          {#if !intervalValid}<p class="field-error" role="alert">Enter a whole number from 30 to 86,400 seconds.</p>{/if}
          <div class="settings-group settings-readonly"><div><strong>Last completed check</strong><p>The value shown in Watch comes from the actual check cycle.</p></div><span>{dashboard.cycle.finished_at ? new Date(dashboard.cycle.finished_at * 1000).toLocaleString() : "Not reported"}</span></div>
        {:else if category === "dispatcher"}
          <div class="settings-panel-heading"><p class="eyebrow">SERVICE / OPERATIONAL POLICY</p><h2>Dispatch policy</h2><p>Changes persist against the current policy revision and take effect without restarting the service.</p></div>
          <div class="policy-preset"><label for="policy-mode">Policy mode</label><select id="policy-mode" value={mode} onchange={(event) => applyMode((event.currentTarget as HTMLSelectElement).value)}><option value="conservative">Conservative</option><option value="balanced">Balanced</option><option value="custom">Custom</option></select><span>Choosing a preset fills its limits; editing any limit changes the mode to Custom.</span></div>
          <div class="policy-form-grid">
            <label>Project concurrency limit<input type="number" min="1" bind:value={maxConcurrent} oninput={markPolicyDirty} /></label>
            <label>Global concurrency limit<input type="number" min="1" bind:value={globalConcurrent} oninput={markPolicyDirty} /></label>
            <label>Maximum recoveries<input type="number" min="0" max="2" bind:value={maxRecoveries} oninput={markPolicyDirty} /></label>
            <label>Recovery backoff seconds<input type="number" min="1" bind:value={backoff} oninput={markPolicyDirty} /></label>
            <label>Busy-worker stall threshold (seconds)<input type="number" min="1" max="86400" bind:value={stall} oninput={markPolicyDirty} /></label>
            <label>Concurrent observation requests<input type="number" min="1" max="8" bind:value={observations} oninput={markPolicyDirty} /></label>
            <label>Provider request timeout (seconds)<input type="number" min="1" max="30" bind:value={requestTimeout} oninput={markPolicyDirty} /></label>
            <label>Quota reserve<input type="number" min="0" step="any" bind:value={reserve} oninput={markPolicyDirty} /></label>
            <label>Model limits (one model: limit per line)<textarea bind:value={modelLimitsText} oninput={markPolicyDirty} placeholder="codex-5: 3"></textarea></label>
          </div>
          <div class="policy-toggles">
            <label class="checkbox-field"><input type="checkbox" bind:checked={allowUnknownQuota} onchange={markPolicyDirty} />Allow quota not reported</label>
            <label class="checkbox-field"><input type="checkbox" bind:checked={allowNative} onchange={markPolicyDirty} />Allow native workers</label>
          </div>
          <div class="policy-form-grid native-policy">
            <label>Native concurrency ceiling<input type="number" min="0" bind:value={nativeCeiling} oninput={markPolicyDirty} disabled={!allowNative} /></label>
            <label>Native budget reserve<input type="number" min="0" step="any" bind:value={nativeReserve} oninput={markPolicyDirty} disabled={!allowNative} placeholder="Required when enabled" /></label>
          </div>
          <p class="policy-warning">Native routing is off by default. Enable it only with an explicit concurrency ceiling and budget reserve. Recovery is capped at two. Stop blocks new dispatch and recovery; it does not kill already-running remote workers.</p>
          {#if !policyValid}<p class="field-error" role="alert">Check limits, recovery (0–2), model entries, and native ceiling/reserve.</p>{/if}
          <Button tone="info" surface="solid" disabled={!policyValid || saving} onclick={savePolicy}>{saving ? "Saving policy…" : "Save operational policy"}</Button>
          <div class="ownership-callout"><span class="ownership-icon">!</span><div><strong>Persistent dispatch controls</strong><p>Current state: {pauseDispatch ? "paused" : "running"}; emergency stop: {emergencyStopped ? "active" : "clear"}. {dispatchCapability.reason || "Snooze owns dispatch for this project."}</p></div></div>
          <div class="settings-disabled-controls">
            <button type="button" disabled={!dispatchCapability.supported || saving} title={dispatchCapability.reason ?? "Pause or resume new dispatch and recovery."} onclick={() => oncontrol("dispatch-pause", dashboard.project.id, { paused: !pauseDispatch }, revision)}>{pauseDispatch ? "Resume dispatch" : "Pause dispatch"}</button>
            <button type="button" class="emergency" disabled={!emergencyCapability.supported || saving} title={emergencyCapability.reason ?? "Emergency stop blocks new dispatch and recovery."} onclick={() => oncontrol("emergency-stop", dashboard.project.id, { stopped: !emergencyStopped }, revision)}>{emergencyStopped ? "Release emergency stop" : "Emergency stop"}</button>
          </div>
          {#if !dispatchCapability.supported}<p class="capability-reason">External-managed dispatch controls are disabled: {dispatchCapability.reason}</p>{/if}
        {:else}
          <div class="settings-panel-heading"><p class="eyebrow">WORKSPACE / APPEARANCE</p><h2>Reading comfort</h2><p>Use the theme control in the top bar. OS reduced-motion preferences are respected throughout the interface.</p></div>
          <div class="settings-group settings-readonly"><div><strong>Motion</strong><p>Drawer transitions and activity indicators follow your system preference.</p></div><span>System preference</span></div>
        {/if}
      {/snippet}
    </SettingsLayout>
  </div>
</section>
