/**
 * Collects a DoctorSnapshot from the running system so the pure rules in
 * doctor.ts can diagnose it. Every stage sets `checked` only after the
 * corresponding observation was actually made; nothing is assumed.
 *
 * Side effects are opt-in and bounded: `live` sends one authenticated MCP
 * initialize probe (the existing credential probe) and one tool inventory
 * refresh; `funnel` runs read-only `systemctl is-active` and
 * `tailscale serve status --json`. Nothing here changes configuration.
 */

import type { DoctorSnapshot, FunnelMountSnapshot } from "./doctor.js";
import { LifecycleController, createExecFileRunner, effectiveServeConfig, type CommandRunner } from "./lifecycle.js";
import type { CredentialPool } from "./pool.js";
import type { StateStore } from "./store.js";
import { refreshAccountCapabilities } from "./capabilities.js";
import type { TelemetryRecorder } from "./telemetry.js";

/** ChatGPT's connector OAuth callback; its registration is real evidence. */
export const CHATGPT_CALLBACK_URI = "https://chatgpt.com/connector_platform_oauth_redirect";

export interface DoctorCollectOptions {
  /** URL of this gateway's /healthz, when checking from outside the process. */
  healthUrl?: string;
  /** True when the caller IS the running gateway process (dashboard). */
  inProcess?: boolean;
  /** Send a live upstream probe and refresh one tool inventory. */
  live?: boolean;
  /** Inspect the service unit and Tailscale Serve/Funnel config (read-only). */
  funnel?: boolean;
  /** Fetch the public OAuth metadata through the public URL (Funnel path). */
  publicMetadata?: boolean;
  callbackUri?: string;
  runner?: CommandRunner;
  telemetry?: TelemetryRecorder;
}

export async function collectDoctorSnapshot(
  store: StateStore,
  pool: CredentialPool,
  options: DoctorCollectOptions = {},
): Promise<DoctorSnapshot> {
  let state = await store.load();
  const snapshot: DoctorSnapshot = {};

  if (options.inProcess) {
    snapshot.process = { checked: true, running: true, listening: true, healthStatus: 200 };
  } else if (options.healthUrl) {
    const url = new URL(options.healthUrl);
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
      snapshot.process = { checked: true, running: true, listening: true, healthStatus: response.status, port: Number(url.port) || undefined };
    } catch {
      snapshot.process = { checked: true, running: false, listening: false, port: Number(url.port) || undefined };
    }
  }

  snapshot.config = {
    checked: true,
    upstreamUrl: state.config.upstreamUrl || undefined,
    publicBaseUrl: state.config.publicBaseUrl || undefined,
    basePath: state.config.basePath,
    requestTimeoutMs: state.config.requestTimeoutMs,
  };

  if (options.live) {
    const candidate = state.accounts.find((a) => a.enabled);
    if (candidate) {
      await pool.probeAccount(candidate.id);
      await refreshAccountCapabilities(store, candidate.id, options.telemetry);
      state = await store.load();
    }
  }

  const accounts = [];
  for (const account of state.accounts) {
    let secretAvailable = false;
    try {
      // Decrypt only to prove the stored material is readable; discard it.
      secretAvailable = (await store.revealToken(account)).length > 0;
    } catch {
      secretAvailable = false;
    }
    accounts.push({
      id: account.id,
      label: account.label,
      enabled: account.enabled,
      secretAvailable,
      state: account.stats.state,
      lastStatus: account.stats.lastStatus,
      lastProbeStatus: account.stats.lastProbeStatus,
      lastProbeOk: account.stats.lastProbeOk,
      lastError: account.stats.lastError,
      cooldownUntil: account.stats.cooldownUntil,
    });
  }
  snapshot.credentials = { checked: true, observedAt: Date.now(), accounts };

  // Upstream evidence is a real initialize probe: the most recent successful
  // one on an enabled account (the upstream is reachable), else the most
  // recent failure. Per-credential problems are reported under credentials.
  const probes = state.accounts
    .filter((a) => a.enabled && a.stats.lastProbeAt)
    .sort((a, b) => (b.stats.lastProbeAt || 0) - (a.stats.lastProbeAt || 0));
  const probed = probes.find((a) => a.stats.lastProbeOk) || probes[0];
  if (probed) {
    const error = probed.stats.lastProbeError;
    snapshot.upstream = {
      checked: true,
      connected: probed.stats.lastProbeStatus !== undefined,
      timedOut: Boolean(error && /timed out/i.test(error)),
      status: probed.stats.lastProbeStatus,
      initializeOk: probed.stats.lastProbeOk === true,
      error: probed.stats.lastProbeOk ? undefined : error,
    };
  }

  const inventories = Object.entries(state.capabilities || {}).filter(([id]) => state.accounts.some((a) => a.id === id));
  if (inventories.length) {
    const ok = inventories.filter(([, caps]) => caps.ok);
    const latest = (ok.length ? ok : inventories).sort((a, b) => b[1].capturedAt - a[1].capturedAt)[0][1];
    snapshot.tools = {
      checked: true,
      toolsListOk: latest.ok,
      toolCount: latest.tools.length,
      error: latest.ok ? undefined : latest.error,
    };
  }

  if (options.publicMetadata) {
    const issuer = state.config.publicBaseUrl.replace(/\/$/, "");
    const oauth: NonNullable<DoctorSnapshot["oauth"]> = {
      // Expectations and local registrations are known even when the public
      // endpoint cannot be reached; only successful HTTP observations count
      // as a completed public-metadata check.
      checked: false,
      expectedIssuer: issuer,
      expectedResource: issuer + "/mcp",
      callbackUri: options.callbackUri || CHATGPT_CALLBACK_URI,
      registeredRedirectUris: [...new Set(state.oauthClients.flatMap((c) => c.redirectUris))],
    };
    try {
      const metadataResponse = await fetch(issuer + "/.well-known/oauth-authorization-server", { signal: AbortSignal.timeout(8_000) });
      const resourceResponse = await fetch(issuer + "/.well-known/oauth-protected-resource", { signal: AbortSignal.timeout(8_000) });
      if (metadataResponse.ok && resourceResponse.ok) {
        const meta = await metadataResponse.json() as any;
        const resource = await resourceResponse.json() as any;
        oauth.advertisedIssuer = typeof meta?.issuer === "string" ? meta.issuer : undefined;
        oauth.observedResource = typeof resource?.resource === "string" ? resource.resource : undefined;
        oauth.checked = true;
      }
    } catch {
      // Keep checked=false and expose no parsed values after transport/JSON errors.
    }
    snapshot.oauth = oauth;
  }

  if (options.funnel) {
    try {
      const controller = new LifecycleController(options.runner || createExecFileRunner(15_000));
      const observed = await controller.observe();
      const mounts: FunnelMountSnapshot[] = [];
      const host = observed.routes.hostPort;
      for (const [path, handler] of Object.entries((host && effectiveServeConfig(observed.serveConfig).Web?.[host]?.Handlers) || {})) {
        let targetHost: string | undefined;
        let targetPort: number | undefined;
        try {
          const target = new URL(String(handler.Proxy));
          targetHost = target.hostname;
          targetPort = Number(target.port) || undefined;
        } catch {
          // Non-proxy handlers (text, redirect) have no target.
        }
        mounts.push({ path, targetHost, targetPort });
      }
      snapshot.funnel = {
        checked: true,
        enabled: observed.routes.funnel,
        expectedPath: observed.routes.root.target === "http://127.0.0.1:2030" ? "/" : state.config.basePath || "/token2oauth",
        reportedCollision: observed.routes.owned.state === "collision",
        mounts,
      };
    } catch {
      snapshot.funnel = { checked: false };
    }
  }

  return snapshot;
}
