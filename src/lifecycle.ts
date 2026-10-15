// Lifecycle planning and control for the ROTOXY user service and its
// owned Tailscale Serve/Funnel path on a shared HTTPS listener.
//
// Everything here is injectable: planners are pure functions over an observed
// state snapshot, and the controller only touches the OS through a
// CommandRunner. The controller is dry-run by default and only executes a plan
// it is explicitly handed. See docs/LIFECYCLE.md.

import { execFile } from "node:child_process";

export const SERVICE_UNIT = "token2oauth.service";
export const HTTPS_PORT = 443;
export const ROOT_PATH = "/";
export const ROOT_TARGET = "http://127.0.0.1:2025";
export const OWNED_PATH = "/token2oauth";
export const OWNED_TARGET = "http://127.0.0.1:2030";

// ---------------------------------------------------------------------------
// Tailscale ServeConfig (subset of ipn.ServeConfig as printed by
// `tailscale serve status --json`).

export interface HttpHandler {
  Path?: string;
  Proxy?: string;
  Text?: string;
  Redirect?: string;
  [key: string]: unknown;
}

export interface WebServerConfig {
  Handlers?: Record<string, HttpHandler>;
  [key: string]: unknown;
}

export interface TcpPortHandler {
  HTTPS?: boolean;
  HTTP?: boolean;
  TCPForward?: string;
  TerminateTLS?: string;
  [key: string]: unknown;
}

export interface ServeConfig {
  TCP?: Record<string, TcpPortHandler>;
  Web?: Record<string, WebServerConfig>;
  AllowFunnel?: Record<string, boolean>;
  Services?: Record<string, unknown>;
  Foreground?: Record<string, unknown>;
  [key: string]: unknown;
}

export function parseServeConfig(text: string): ServeConfig {
  const trimmed = text.trim();
  // An empty Serve config prints as "{}" or nothing at all.
  if (!trimmed) return {};
  const parsed: unknown = JSON.parse(trimmed);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("tailscale serve status --json did not return an object");
  }
  return parsed as ServeConfig;
}

/** Stable JSON with sorted keys, used for snapshot comparison. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = sortKeys(v);
    }
    return out;
  }
  return value;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value ?? {})) as T;
}

/** Normalizes a proxy target for exact comparison (case, trailing slash). */
export function normalizeTarget(target: string | undefined): string | undefined {
  if (!target) return undefined;
  const raw = target.trim();
  try {
    const url = new URL(raw);
    const path = url.pathname.replace(/\/+$/, "");
    return `${url.protocol}//${url.host}${path}${url.search}`.toLowerCase();
  } catch {
    return raw.replace(/\/+$/, "").toLowerCase();
  }
}

// ---------------------------------------------------------------------------
// Owned path helpers. Future pool routes must stay inside OWNED_PATH.

const SEGMENT = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function isWithinOwnedPath(path: string, owned = OWNED_PATH): boolean {
  if (typeof path !== "string" || !path.startsWith("/")) return false;
  if (/[\\?#%]/.test(path)) return false;
  const segments = path.split("/").slice(1);
  if (segments.some((s) => s === "." || s === "..")) return false;
  return path === owned || path === owned + "/" || path.startsWith(owned + "/");
}

/** Builds `/token2oauth/<name>` for a pool, rejecting anything that could escape. */
export function ownedSubpath(name: string, owned = OWNED_PATH): string {
  if (!SEGMENT.test(name)) {
    throw new Error(`invalid pool path segment ${JSON.stringify(name)}: use lowercase letters, digits and dashes`);
  }
  const path = `${owned}/${name}`;
  if (!isWithinOwnedPath(path, owned)) throw new Error(`pool path ${path} escapes ${owned}`);
  return path;
}

export function assertWithinOwnedPath(path: string, owned = OWNED_PATH): string {
  if (!isWithinOwnedPath(path, owned)) throw new Error(`path ${path} is outside the owned prefix ${owned}`);
  return path;
}

// ---------------------------------------------------------------------------
// Route inspection.

export interface RouteExpectations {
  httpsPort: number;
  rootPath: string;
  rootTarget: string;
  ownedPath: string;
  ownedTarget: string;
  /** MagicDNS host to inspect when more than one :443 listener exists. */
  host?: string;
}

export const DEFAULT_ROUTES: RouteExpectations = {
  httpsPort: HTTPS_PORT,
  rootPath: ROOT_PATH,
  rootTarget: ROOT_TARGET,
  ownedPath: OWNED_PATH,
  ownedTarget: OWNED_TARGET,
};

export type OwnedRouteState = "absent" | "owned" | "collision";

export interface RouteInspection {
  /** Web key such as `node.tailnet.ts.net:443`, or undefined if no listener. */
  hostPort?: string;
  listenerExists: boolean;
  /** True when AllowFunnel is set for the shared listener. */
  funnel: boolean;
  /** True when port 443 is a raw TCP forward rather than HTTPS web serve. */
  tcpForwarding: boolean;
  ambiguousHosts: string[];
  root: { present: boolean; target?: string; matchesExpected: boolean };
  owned: { state: OwnedRouteState; mount?: string; target?: string; handler?: HttpHandler };
  /** Handlers at owned sub-paths such as /token2oauth/pool-a. */
  ownedSubpaths: Array<{ mount: string; target?: string }>;
  /** Every mount on the listener that is neither root nor owned. */
  foreignMounts: string[];
  handlerCount: number;
}

/** Read-only projection of background and foreground Serve listeners. */
export function effectiveServeConfig(sc: ServeConfig): ServeConfig {
  const out = clone(sc); delete out.Foreground;
  for (const value of Object.values(sc.Foreground || {})) {
    if (!value || typeof value !== "object") continue;
    const layer = value as ServeConfig;
    for (const [host, web] of Object.entries(layer.Web || {})) {
      if (out.Web?.[host]) throw new Error("Overlapping foreground/background HTTPS listeners");
      (out.Web ||= {})[host] = clone(web);
    }
    Object.assign(out.TCP ||= {}, layer.TCP || {});
    Object.assign(out.AllowFunnel ||= {}, layer.AllowFunnel || {});
  }
  return out;
}

export function inspectRoutes(sc: ServeConfig, routes: RouteExpectations = DEFAULT_ROUTES): RouteInspection {
  sc = effectiveServeConfig(sc);
  const suffix = `:${routes.httpsPort}`;
  const candidates = Object.keys(sc.Web ?? {}).filter((hp) => hp.endsWith(suffix));
  let hostPort: string | undefined;
  let ambiguousHosts: string[] = [];
  if (routes.host) {
    hostPort = candidates.find((hp) => hp === `${routes.host}${suffix}`);
  } else if (candidates.length === 1) {
    hostPort = candidates[0];
  } else if (candidates.length > 1) {
    ambiguousHosts = candidates.sort();
  }

  const tcp = sc.TCP?.[String(routes.httpsPort)];
  const tcpForwarding = Boolean(tcp?.TCPForward);
  const handlers = (hostPort && sc.Web?.[hostPort]?.Handlers) || {};
  const mounts = Object.keys(handlers);

  const rootHandler = handlers[routes.rootPath];
  const rootTarget = rootHandler?.Proxy;

  const ownedMounts = [routes.ownedPath, routes.ownedPath + "/"];
  const ownedMount = ownedMounts.find((m) => handlers[m]);
  let owned: RouteInspection["owned"] = { state: "absent" };
  if (ownedMount) {
    const handler = handlers[ownedMount];
    const exact =
      ownedMount === routes.ownedPath &&
      normalizeTarget(handler.Proxy) === normalizeTarget(routes.ownedTarget) &&
      !handler.Path && !handler.Text && !handler.Redirect;
    owned = { state: exact ? "owned" : "collision", mount: ownedMount, target: handler.Proxy, handler };
  }

  const ownedSubpaths = mounts
    .filter((m) => !ownedMounts.includes(m) && m.startsWith(routes.ownedPath + "/"))
    .sort()
    .map((mount) => ({ mount, target: handlers[mount].Proxy }));
  const foreignMounts = mounts
    .filter((m) => m !== routes.rootPath && !ownedMounts.includes(m) && !m.startsWith(routes.ownedPath + "/"))
    .sort();

  return {
    hostPort,
    listenerExists: Boolean(hostPort) || ambiguousHosts.length > 0,
    funnel: Boolean(hostPort && sc.AllowFunnel?.[hostPort]),
    tcpForwarding,
    ambiguousHosts,
    root: {
      present: Boolean(rootHandler),
      target: rootTarget,
      matchesExpected: normalizeTarget(rootTarget) === normalizeTarget(routes.rootTarget),
    },
    owned,
    ownedSubpaths,
    foreignMounts,
    handlerCount: mounts.length,
  };
}

/**
 * The part of the Serve config this module must never change: everything
 * except the owned mount itself, and except the listener scaffolding that
 * exists only because the owned mount is its sole handler.
 */
export function unrelatedView(sc: ServeConfig, routes: RouteExpectations = DEFAULT_ROUTES): ServeConfig {
  const view = clone(sc);
  delete view.ETag;
  const suffix = `:${routes.httpsPort}`;
  for (const hp of Object.keys(view.Web ?? {})) {
    if (!hp.endsWith(suffix)) continue;
    if (routes.host && hp !== `${routes.host}${suffix}`) continue;
    const handlers = view.Web![hp].Handlers ?? {};
    delete handlers[routes.ownedPath];
    if (Object.keys(handlers).length === 0) {
      delete view.Web![hp];
      delete view.AllowFunnel?.[hp];
      if (view.TCP?.[String(routes.httpsPort)] && !view.TCP[String(routes.httpsPort)].TCPForward) {
        delete view.TCP[String(routes.httpsPort)];
      }
    }
  }
  for (const key of ["Web", "TCP", "AllowFunnel"] as const) {
    if (view[key] && Object.keys(view[key] as object).length === 0) delete view[key];
  }
  return view;
}

// ---------------------------------------------------------------------------
// Observed state and plans.

export type ServiceActiveState = "active" | "inactive" | "failed" | "activating" | "deactivating" | "unknown";

export interface ObservedState {
  service: { active: ServiceActiveState; enabled?: string };
  serveConfig: ServeConfig;
  routes: RouteInspection;
  /** canonicalJson(unrelatedView(serveConfig)) at observation time. */
  unrelatedFingerprint: string;
  /** canonicalJson(serveConfig) at observation time. */
  configFingerprint: string;
}

export type ExposureMode = "funnel" | "serve";
export type LifecycleAction = "up" | "down" | "status";
export type InvokedFrom = "cli" | "dashboard";

export type StepKind = "systemctl" | "tailscale";

export interface PlanStep {
  id: "service-start" | "service-stop" | "route-add" | "route-remove";
  kind: StepKind;
  command: string;
  args: string[];
  description: string;
}

export interface LifecyclePlan {
  action: LifecycleAction;
  ok: boolean;
  blockers: string[];
  warnings: string[];
  steps: PlanStep[];
  /** Fingerprints the plan was computed against; execution refuses on drift. */
  basis: { configFingerprint: string; unrelatedFingerprint: string };
  routes: RouteExpectations;
}

export interface PlanOptions {
  routes?: Partial<RouteExpectations>;
  /** Mode to use only when no :443 listener exists yet. Defaults to funnel. */
  mode?: ExposureMode;
  /** Leave the Tailscale route in place on down (service stop only). */
  keepRoute?: boolean;
  /** Skip the service stop on down (route removal only). */
  keepService?: boolean;
  invokedFrom?: InvokedFrom;
  /** Required for a dashboard-initiated down: the dashboard cannot start itself again. */
  acknowledgeNoSelfRestart?: boolean;
}

function resolveRoutes(partial?: Partial<RouteExpectations>): RouteExpectations {
  const routes = { ...DEFAULT_ROUTES, ...partial };
  if (
    routes.ownedPath === routes.rootPath ||
    !routes.ownedPath.startsWith("/") ||
    routes.ownedPath.endsWith("/") ||
    !isWithinOwnedPath(routes.ownedPath, OWNED_PATH)
  ) {
    throw new Error(`owned path ${routes.ownedPath} must be a non-root path without a trailing slash`);
  }
  return routes;
}

function emptyPlan(action: LifecycleAction, state: ObservedState, routes: RouteExpectations): LifecyclePlan {
  return {
    action,
    ok: true,
    blockers: [],
    warnings: [],
    steps: [],
    basis: {
      configFingerprint: state.configFingerprint,
      unrelatedFingerprint: canonicalJson(unrelatedView(state.serveConfig, routes)),
    },
    routes,
  };
}

function commonRouteChecks(plan: LifecyclePlan, r: RouteInspection, routes: RouteExpectations): void {
  if (r.ambiguousHosts.length) {
    plan.blockers.push(`multiple :${routes.httpsPort} listeners (${r.ambiguousHosts.join(", ")}); pass routes.host to choose one`);
  }
  if (r.tcpForwarding) {
    plan.blockers.push(`port ${routes.httpsPort} is a raw TCP forward; refusing to touch web handlers on it`);
  }
  if (r.listenerExists && !r.root.present) {
    plan.warnings.push(`no root handler at ${routes.rootPath} on the shared listener`);
  } else if (r.root.present && !r.root.matchesExpected) {
    plan.warnings.push(`root ${routes.rootPath} maps ${r.root.target}, expected ${routes.rootTarget}; it will be left untouched`);
  }
  if (r.foreignMounts.length) {
    plan.warnings.push(`other mounts on the shared listener will be preserved: ${r.foreignMounts.join(", ")}`);
  }
}

/** The subcommand that adds/removes the owned mount without flipping AllowFunnel. */
function routeSubcommand(r: RouteInspection, mode: ExposureMode): ExposureMode {
  if (!r.listenerExists) return mode;
  return r.funnel ? "funnel" : "serve";
}

export function planUp(state: ObservedState, options: PlanOptions = {}): LifecyclePlan {
  const routes = resolveRoutes(options.routes);
  const plan = emptyPlan("up", state, routes);
  if (Object.keys(state.serveConfig.Foreground || {}).length) plan.blockers.push("Foreground services are manually managed; use rotoxy up/down instead of changing persistent routes.");
  const r = inspectRoutes(state.serveConfig, routes);
  // With no explicit mode, follow the existing listener; funnel only when creating one.
  const mode = options.mode ?? routeSubcommand(r, "funnel");
  commonRouteChecks(plan, r, routes);

  if (r.owned.state === "collision") {
    plan.blockers.push(
      `collision: ${r.owned.mount} already maps ${r.owned.target ?? "a non-proxy handler"}, expected ${routes.ownedTarget}`,
    );
  }
  if (r.listenerExists && r.hostPort && mode !== routeSubcommand(r, mode)) {
    // `tailscale serve` on a Funnel listener clears AllowFunnel for the whole
    // listener, and `tailscale funnel` on a Serve listener sets it. Either
    // would change exposure of the root route, so refuse instead.
    plan.blockers.push(
      `requested ${mode} but the shared listener is ${r.funnel ? "Funnel" : "Serve-only"}; ` +
        `adding with ${mode} would change AllowFunnel for every route on it`,
    );
  }

  if (state.service.active !== "active") {
    plan.steps.push({
      id: "service-start",
      kind: "systemctl",
      command: "systemctl",
      args: ["--user", "start", SERVICE_UNIT],
      description: `start ${SERVICE_UNIT}`,
    });
  }
  if (r.owned.state === "absent") {
    const sub = routeSubcommand(r, mode);
    plan.steps.push({
      id: "route-add",
      kind: "tailscale",
      command: "tailscale",
      args: [sub, "--bg", `--https=${routes.httpsPort}`, `--set-path=${routes.ownedPath}`, routes.ownedTarget],
      description: `add ${routes.ownedPath} → ${routes.ownedTarget} (${sub})`,
    });
  }
  plan.ok = plan.blockers.length === 0;
  if (!plan.ok) plan.steps = [];
  return plan;
}

export function planDown(state: ObservedState, options: PlanOptions = {}): LifecyclePlan {
  const routes = resolveRoutes(options.routes);
  const plan = emptyPlan("down", state, routes);
  if (Object.keys(state.serveConfig.Foreground || {}).length) plan.blockers.push("Foreground services are manually managed; use rotoxy up/down instead of changing persistent routes.");
  const r = inspectRoutes(state.serveConfig, routes);
  commonRouteChecks(plan, r, routes);

  if (options.invokedFrom === "dashboard" && !options.keepService && !options.acknowledgeNoSelfRestart) {
    plan.blockers.push(
      "down from the dashboard stops the process serving the dashboard; it cannot start itself again. " +
        "Use the local CLI / a persistent control plane, or pass acknowledgeNoSelfRestart",
    );
  }

  if (!options.keepRoute) {
    if (r.owned.state === "collision") {
      plan.blockers.push(
        `refusing to remove ${r.owned.mount}: it maps ${r.owned.target ?? "a non-proxy handler"}, not ${routes.ownedTarget}`,
      );
    } else if (r.owned.state === "owned") {
      if (r.handlerCount <= 1) {
        // Tailscale cascades: removing the last handler deletes the listener's
        // TCP entry and AllowFunnel flag (ipn.ServeConfig.RemoveWebHandler).
        plan.blockers.push(
          `${routes.ownedPath} is the only handler on the listener; removing it would delete the listener and its AllowFunnel setting`,
        );
      } else {
        const sub = routeSubcommand(r, "serve");
        plan.steps.push({
          id: "route-remove",
          kind: "tailscale",
          command: "tailscale",
          args: [sub, `--https=${routes.httpsPort}`, `--set-path=${routes.ownedPath}`, "off"],
          description: `remove only ${routes.ownedPath} (${sub})`,
        });
      }
    } else {
      plan.warnings.push(`${routes.ownedPath} is not mapped; nothing to remove`);
    }
    if (r.ownedSubpaths.length) {
      plan.warnings.push(`owned sub-paths are left in place: ${r.ownedSubpaths.map((s) => s.mount).join(", ")}`);
    }
  }

  if (!options.keepService && state.service.active !== "inactive") {
    plan.steps.push({
      id: "service-stop",
      kind: "systemctl",
      command: "systemctl",
      args: ["--user", "stop", SERVICE_UNIT],
      description: `stop ${SERVICE_UNIT}`,
    });
  }
  plan.ok = plan.blockers.length === 0;
  if (!plan.ok) plan.steps = [];
  return plan;
}

export interface LifecycleStatus {
  service: ObservedState["service"];
  routes: RouteInspection;
  healthy: boolean;
  problems: string[];
}

export function planStatus(state: ObservedState, options: PlanOptions = {}): LifecycleStatus {
  const routes = resolveRoutes(options.routes);
  const problems: string[] = [];
  const r = inspectRoutes(state.serveConfig, routes);
  if (state.service.active !== "active") problems.push(`${SERVICE_UNIT} is ${state.service.active}`);
  if (r.owned.state === "absent") problems.push(`${routes.ownedPath} is not mapped`);
  if (r.owned.state === "collision") problems.push(`${r.owned.mount} maps ${r.owned.target ?? "a non-proxy handler"}`);
  if (!r.root.present) problems.push(`root ${routes.rootPath} is not mapped`);
  else if (!r.root.matchesExpected) problems.push(`root maps ${r.root.target}, expected ${routes.rootTarget}`);
  if (r.ambiguousHosts.length) problems.push(`multiple :${routes.httpsPort} listeners`);
  if (r.tcpForwarding) problems.push(`port ${routes.httpsPort} is a raw TCP forward`);
  return { service: state.service, routes: r, healthy: problems.length === 0, problems };
}

// ---------------------------------------------------------------------------
// Controller.

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs a command without a shell. Must resolve (not reject) on non-zero exit. */
export type CommandRunner = (command: string, args: string[]) => Promise<CommandResult>;

/** The production runner. Not used by tests. */
export function createExecFileRunner(timeoutMs = 30_000): CommandRunner {
  return (command, args) =>
    new Promise((resolve) => {
      execFile(command, args, { timeout: timeoutMs, encoding: "utf8" }, (error, stdout, stderr) => {
        const code = error ? (typeof (error as any).code === "number" ? (error as any).code : 1) : 0;
        resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? error?.message ?? "") });
      });
    });
}

const ALLOWED_ACTIVE: ServiceActiveState[] = ["active", "inactive", "failed", "activating", "deactivating"];

export interface StepResult {
  step: PlanStep;
  ok: boolean;
  result?: CommandResult;
  error?: string;
}

export interface ExecutionReport {
  executed: boolean;
  ok: boolean;
  plan: LifecyclePlan;
  results: StepResult[];
  error?: string;
  /** Planned commands, rendered for display in dry-run. */
  commands: string[];
}

export interface ExecuteOptions {
  /** Must be exactly true to run anything. Anything else is a dry run. */
  execute?: boolean;
}

export function renderCommand(step: PlanStep): string {
  return [step.command, ...step.args].map((a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : JSON.stringify(a))).join(" ");
}

export class LifecycleController {
  constructor(
    private readonly run: CommandRunner,
    private readonly routeOptions: Partial<RouteExpectations> = {},
  ) {}

  get routes(): RouteExpectations {
    return resolveRoutes(this.routeOptions);
  }

  async observe(): Promise<ObservedState> {
    const routes = this.routes;
    const active = await this.run("systemctl", ["--user", "is-active", SERVICE_UNIT]);
    const enabled = await this.run("systemctl", ["--user", "is-enabled", SERVICE_UNIT]);
    const activeWord = active.stdout.trim() as ServiceActiveState;
    const serve = await this.run("tailscale", ["serve", "status", "--json"]);
    if (serve.code !== 0) {
      throw new Error(`tailscale serve status --json failed: ${serve.stderr.trim() || `exit ${serve.code}`}`);
    }
    const serveConfig = parseServeConfig(serve.stdout);
    return {
      service: {
        active: ALLOWED_ACTIVE.includes(activeWord) ? activeWord : "unknown",
        enabled: enabled.stdout.trim() || undefined,
      },
      serveConfig,
      routes: inspectRoutes(serveConfig, routes),
      unrelatedFingerprint: canonicalJson(unrelatedView(serveConfig, routes)),
      configFingerprint: canonicalJson(stripEtag(serveConfig)),
    };
  }

  plan(action: "up" | "down", options?: PlanOptions): Promise<LifecyclePlan>;
  plan(action: "status", options?: PlanOptions): Promise<LifecycleStatus>;
  async plan(action: LifecycleAction, options: PlanOptions = {}): Promise<LifecyclePlan | LifecycleStatus> {
    const state = await this.observe();
    const merged = { ...options, routes: { ...this.routeOptions, ...options.routes } };
    if (action === "up") return planUp(state, merged);
    if (action === "down") return planDown(state, merged);
    return planStatus(state, merged);
  }

  async status(): Promise<LifecycleStatus> {
    return planStatus(await this.observe(), { routes: this.routeOptions });
  }

  /**
   * Executes exactly the steps of `plan`, and only with `{ execute: true }`.
   * Before each Tailscale write the Serve config is re-read and must still
   * match the plan's basis; after it, the config is re-read and everything
   * unrelated to the owned mount must be unchanged.
   */
  async execute(plan: LifecyclePlan, options: ExecuteOptions = {}): Promise<ExecutionReport> {
    const report: ExecutionReport = {
      executed: false,
      ok: plan.ok,
      plan,
      results: [],
      commands: plan.steps.map(renderCommand),
    };
    if (!plan.ok) {
      report.error = `plan is blocked: ${plan.blockers.join("; ")}`;
      return report;
    }
    if (options.execute !== true) return report;
    report.executed = true;

    for (const step of plan.steps) {
      try {
        validateStep(step, plan.routes);
      } catch (error: any) {
        return fail(report, step, error.message);
      }
      if (step.kind === "tailscale") {
        const before = await this.observe();
        if (before.configFingerprint !== plan.basis.configFingerprint) {
          return fail(report, step, "Serve config changed since the plan was made; re-plan before executing");
        }
      }
      const result = await this.run(step.command, step.args);
      if (result.code !== 0) {
        return fail(report, step, `${renderCommand(step)} exited ${result.code}: ${result.stderr.trim()}`, result);
      }
      if (step.kind === "tailscale") {
        const after = await this.observe();
        if (canonicalJson(unrelatedView(after.serveConfig, plan.routes)) !== plan.basis.unrelatedFingerprint) {
          return fail(report, step, "unrelated Serve/Funnel config changed after the write; inspect `tailscale serve status --json` now", result);
        }
        const expected: OwnedRouteState = step.id === "route-add" ? "owned" : "absent";
        const found = inspectRoutes(after.serveConfig, plan.routes).owned.state;
        if (found !== expected) {
          return fail(report, step, `expected ${plan.routes.ownedPath} to be ${expected}, found ${found}`, result);
        }
      }
      report.results.push({ step, ok: true, result });
    }
    report.ok = true;
    return report;
  }
}

function stripEtag(sc: ServeConfig): ServeConfig {
  const copy = clone(sc);
  delete copy.ETag;
  return copy;
}

function fail(report: ExecutionReport, step: PlanStep, error: string, result?: CommandResult): ExecutionReport {
  report.results.push({ step, ok: false, result, error });
  report.ok = false;
  report.error = error;
  return report;
}

/**
 * Defence in depth: a plan object could have been edited or deserialized, so
 * re-check that each step is one of the exact commands this module emits.
 */
export function validateStep(step: PlanStep, routes: RouteExpectations): void {
  const argv = [step.command, ...step.args].join("\u0000");
  const allowed = new Set<string>();
  allowed.add(["systemctl", "--user", "start", SERVICE_UNIT].join("\u0000"));
  allowed.add(["systemctl", "--user", "stop", SERVICE_UNIT].join("\u0000"));
  for (const sub of ["funnel", "serve"]) {
    allowed.add(["tailscale", sub, "--bg", `--https=${routes.httpsPort}`, `--set-path=${routes.ownedPath}`, routes.ownedTarget].join("\u0000"));
    allowed.add(["tailscale", sub, `--https=${routes.httpsPort}`, `--set-path=${routes.ownedPath}`, "off"].join("\u0000"));
  }
  // The owned path is pinned to ROTOXY's own prefix: even a tampered plan
  // object cannot aim a Serve/Funnel write at "/" or another service's mount.
  if (
    !allowed.has(argv) ||
    routes.ownedPath === routes.rootPath ||
    routes.ownedPath === "/" ||
    !isWithinOwnedPath(routes.ownedPath, OWNED_PATH)
  ) {
    throw new Error(`refusing unrecognised lifecycle command: ${renderCommand(step)}`);
  }
}
