#!/usr/bin/env node
import { execFile, execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { promisify } from "node:util";
import { Command } from "commander";
import { CredentialPool } from "./pool.js";
import { generateAdminPassword } from "./admin-security.js";
import { LifecycleController, OWNED_PATH, createExecFileRunner, renderCommand, type LifecyclePlan } from "./lifecycle.js";
import { collectDoctorSnapshot } from "./doctor-runtime.js";
import { diagnoseDoctorSnapshot, planDoctorRepairs, type RepairCandidate } from "./doctor.js";
import { refreshAccountCapabilities, toolCatalog } from "./capabilities.js";
import { compileToolPolicy, type ToolPolicy } from "./tool-policy.js";
import { migrateLegacyPool, PoolSchemaError } from "./pool-schema.js";
import { StateStore, normalizeBasePath } from "./store.js";
import { startServer } from "./server.js";
import type { GatewayConfig, PoolStrategy } from "./types.js";
import { configureClientConnection, inspectClientConnections, manualClientSetupNotes, removeClientConnection, restoreClientConnection, type LocalMcpClient } from "./client-connections.js";

const execFileAsync = promisify(execFile);
const program = new Command();

program
  .name("token2oauth")
  .description("OAuth 2.1 facade + smart bearer-token pool for remote MCP servers")
  .version("0.2.0");

function store() {
  return new StateStore();
}

async function ensureStore() {
  const s = store();
  const init = await s.init();
  if (init.adminPassword) {
    console.log("Generated admin password: " + init.adminPassword);
    console.log("Save it now; only its password hash is persisted.\n");
  }
  return s;
}

async function promptSecret(prompt = "Bearer token: "): Promise<string> {
  let echoDisabled = false;
  try {
    if (process.stdin.isTTY && process.platform !== "win32") {
      output.write(prompt);
      execFileSync("stty", ["-echo"], { stdio: ["inherit", "ignore", "ignore"] });
      echoDisabled = true;
      const rl = createInterface({ input, output, terminal: false });
      const value = await rl.question("");
      rl.close();
      output.write("\n");
      return value.trim();
    }
    const rl = createInterface({ input, output });
    const value = await rl.question(prompt);
    rl.close();
    return value.trim();
  } finally {
    if (echoDisabled) {
      try { execFileSync("stty", ["echo"], { stdio: ["inherit", "ignore", "ignore"] }); } catch {}
    }
  }
}

program
  .command("init")
  .description("Initialize encrypted state and gateway settings")
  .option("--admin-password <password>", "set an initial admin password")
  .option("--public-base-url <url>", "public gateway base URL, including any path prefix")
  .option("--base-path <path>", "path prefix, e.g. /token2oauth")
  .option("--upstream-url <url>", "upstream MCP endpoint")
  .action(async (opts) => {
    const s = store();
    const result = await s.init({
      adminPassword: opts.adminPassword,
      publicBaseUrl: opts.publicBaseUrl,
      basePath: opts.basePath,
      upstreamUrl: opts.upstreamUrl,
    });
    console.log(result.created ? "Initialized Token2OAuth." : "Token2OAuth is already initialized.");
    console.log("State: " + s.statePath);
    if (result.adminPassword) {
      console.log("\nAdmin password: " + result.adminPassword);
      console.log("Save this now; only a password hash is persisted.");
    }
  });

program
  .command("serve")
  .description("Run the Token2OAuth gateway")
  .option("-p, --port <port>", "listen port", (v) => Number(v), Number(process.env.TOKEN2OAUTH_PORT || 2030))
  .option("--host <host>", "listen host", process.env.TOKEN2OAUTH_HOST || "127.0.0.1")
  .option("--public-base-url <url>", "override saved public base URL")
  .option("--base-path <path>", "override saved path prefix")
  .option("--upstream-url <url>", "override saved upstream MCP endpoint")
  .option("--strategy <strategy>", "override pool strategy")
  .option("--oracle-pool", "enable scoped tools for the configured private Oracle queue")
  .option("--web-tools-config <path>", "explicit owner-private, credential-free provider/account binding file")
  .option("--supervisor-config <path>", "explicitly enable the durable supervisor using a private JSON config")
  .action(async (opts) => {
    const s = await ensureStore();
    if (opts.publicBaseUrl || opts.basePath !== undefined || opts.upstreamUrl || opts.strategy) {
      await s.update((state) => {
        if (opts.publicBaseUrl) state.config.publicBaseUrl = String(opts.publicBaseUrl).replace(/\/$/, "");
        if (opts.basePath !== undefined) state.config.basePath = normalizeBasePath(opts.basePath);
        if (opts.upstreamUrl) state.config.upstreamUrl = String(opts.upstreamUrl);
        if (opts.strategy) state.config.strategy = opts.strategy as PoolStrategy;
      });
    }
    await startServer({ host: opts.host, port: opts.port, supervisorConfigPath: opts.supervisorConfig, oraclePool: opts.oraclePool, webToolsConfigPath: opts.webToolsConfig });
  });

const account = program.command("account").description("Manage encrypted upstream credentials");

account
  .command("add")
  .description("Add an upstream bearer token")
  .requiredOption("-l, --label <label>", "friendly account label")
  .option("--provider <provider>", "provider/preset name", "generic-bearer-mcp")
  .option("--token <token>", "token value (prefer --token-stdin or interactive prompt)")
  .option("--token-env <name>", "read token from an environment variable")
  .option("--token-file <path>", "read token from a file")
  .option("--token-stdin", "read the token from stdin")
  .option("--weight <number>", "routing weight", Number, 1)
  .option("--priority <number>", "priority; lower is preferred in priority mode", Number, 100)
  .action(async (opts) => {
    const s = await ensureStore();
    let token = opts.token ? String(opts.token).trim() : "";
    if (!token && opts.tokenEnv) token = String(process.env[opts.tokenEnv] || "").trim();
    if (!token && opts.tokenFile) token = (await readFile(opts.tokenFile, "utf8")).trim();
    if (!token && opts.tokenStdin) {
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
      token = Buffer.concat(chunks).toString("utf8").trim();
    }
    if (!token) token = await promptSecret();
    if (!token) throw new Error("empty token");
    const added = await s.addAccount({
      label: opts.label,
      token,
      provider: opts.provider,
      weight: opts.weight,
      priority: opts.priority,
    });
    console.log("Added " + added.label + " (" + added.id + ").");
  });

account
  .command("list")
  .alias("ls")
  .description("List accounts and health without revealing secrets")
  .option("--json", "JSON output")
  .action(async (opts) => {
    const s = await ensureStore();
    const state = await s.load();
    const rows = new CredentialPool(s).snapshot(state);
    if (opts.json) return console.log(JSON.stringify(rows, null, 2));
    if (!rows.length) return console.log("No accounts configured.");
    console.table(rows.map((r) => ({
      id: r.id,
      label: r.label,
      enabled: r.enabled,
      state: r.state,
      requests: r.requests,
      success: r.successes,
      failures: r.failures,
      lastHTTP: r.lastStatus || "",
    })));
  });

for (const [name, enabled] of [["enable", true], ["disable", false]] as const) {
  account
    .command(name + " <id>")
    .description(name + " an account")
    .action(async (id) => {
      const s = await ensureStore();
      await s.setAccountEnabled(id, enabled);
      console.log(name + "d " + id);
    });
}

account
  .command("remove <id>")
  .alias("rm")
  .description("Permanently remove an encrypted credential")
  .action(async (id) => {
    const s = await ensureStore();
    console.log((await s.removeAccount(id)) ? "Removed " + id : "Account not found.");
  });

account
  .command("reset-health [id]")
  .description("Clear cooldown/auth-failure state for one account or all accounts")
  .action(async (id) => {
    const s = await ensureStore();
    await s.resetAccountHealth(id);
    console.log(id ? "Reset " + id : "Reset all account health.");
  });

account
  .command("probe [id]")
  .description("Send an authenticated MCP initialize health probe to one account or all enabled accounts")
  .action(async (id) => {
    const s = await ensureStore();
    const credentialPool = new CredentialPool(s);
    const results = id ? [await credentialPool.probeAccount(id)] : await credentialPool.probeAll();
    console.table(results.map((result) => ({
      id: result.accountId,
      label: result.label,
      ok: result.ok,
      status: result.status || "",
      result: result.error || "healthy",
    })));
    if (results.some((result) => !result.ok)) process.exitCode = 1;
  });

const pool = program.command("pool").description("Inspect or configure pool routing");
pool
  .command("status")
  .option("--json")
  .action(async (opts) => {
    const s = await ensureStore();
    const state = await s.load();
    const snapshot = new CredentialPool(s).snapshot(state);
    if (opts.json) console.log(JSON.stringify({ strategy: state.config.strategy, accounts: snapshot }, null, 2));
    else {
      console.log("Strategy: " + state.config.strategy);
      console.table(snapshot.map((r) => ({ label: r.label, state: r.state, active: r.active, requests: r.requests, failures: r.failures })));
    }
  });
pool
  .command("strategy <strategy>")
  .description("Set adaptive-sticky|round-robin|least-used|weighted-random|random|priority")
  .action(async (strategy) => {
    const allowed = ["adaptive-sticky", "round-robin", "least-used", "weighted-random", "random", "priority"];
    if (!allowed.includes(strategy)) throw new Error("Unknown strategy: " + strategy);
    const s = await ensureStore();
    await s.setConfig("strategy", strategy as PoolStrategy);
    console.log("Pool strategy set to " + strategy);
  });

const config = program.command("config").description("Read or change gateway configuration");
config.command("list").option("--json").action(async (opts) => {
  const s = await ensureStore();
  const cfg = (await s.load()).config;
  if (opts.json) console.log(JSON.stringify(cfg, null, 2));
  else console.table(Object.entries(cfg).map(([key, value]) => ({ key, value: Array.isArray(value) ? value.join(",") : String(value) })));
});
config.command("get <key>").action(async (key: keyof GatewayConfig) => {
  const s = await ensureStore();
  const cfg = (await s.load()).config as any;
  if (!(key in cfg)) throw new Error("Unknown config key: " + key);
  console.log(typeof cfg[key] === "object" ? JSON.stringify(cfg[key], null, 2) : cfg[key]);
});
config.command("set <key> <value>").action(async (key: keyof GatewayConfig, raw: string) => {
  const s = await ensureStore();
  const state = await s.load();
  const cfg: any = state.config;
  if (!(key in cfg)) throw new Error("Unknown config key: " + key);
  const current = cfg[key];
  let value: any = raw;
  if (typeof current === "number") value = Number(raw);
  else if (typeof current === "boolean") value = /^(1|true|yes|on)$/i.test(raw);
  else if (Array.isArray(current)) value = raw.split(",").map((v) => /^\d+$/.test(v.trim()) ? Number(v.trim()) : v.trim());
  if (key === "basePath") value = normalizeBasePath(String(value));
  if (key === "publicBaseUrl") value = String(value).replace(/\/$/, "");
  await s.update((st) => { (st.config as any)[key] = value; });
  console.log(String(key) + " = " + (typeof value === "object" ? JSON.stringify(value) : value));
});

const admin = program.command("admin").description("Gateway administrator operations");
admin
  .command("reset-password")
  .description("Rotate the admin password; signs out dashboard sessions in the running server")
  .option("--password <password>", "use this password instead of prompting")
  .option("--generate", "generate a random 256-bit password and print it once")
  .option("--revoke-connections", "also revoke every MCP client's refresh and access tokens")
  .action(async (opts) => {
    const s = await ensureStore();
    const generated = Boolean(opts.generate);
    const password = generated ? generateAdminPassword() : opts.password || await promptSecret("New admin password: ");
    if (password.length < 12) throw new Error("Use at least 12 characters.");
    await s.rotateAdminPassword(password, { revokeConnections: Boolean(opts.revokeConnections) });
    console.log("Admin password updated. Existing admin sessions are signed out.");
    if (opts.revokeConnections) console.log("All MCP client connections were revoked; clients must re-authorize.");
    if (generated) {
      console.log("");
      console.log("NEW ADMIN PASSWORD (shown once, not stored in plain text):");
      console.log(password);
    }
  });

const oauth = program.command("oauth").description("Inspect registered OAuth clients");
oauth.command("clients").option("--json").action(async (opts) => {
  const s = await ensureStore();
  const clients = (await s.load()).oauthClients;
  if (opts.json) console.log(JSON.stringify(clients, null, 2));
  else console.table(clients.map((c) => ({ clientId: c.clientId, name: c.clientName || "", redirects: c.redirectUris.join(", "), created: new Date(c.createdAt).toISOString() })));
});
oauth.command("revoke-client <clientId>").action(async (clientId) => {
  const s = await ensureStore();
  await s.update((state) => {
    state.oauthClients = state.oauthClients.filter((c) => c.clientId !== clientId);
    state.refreshTokens = state.refreshTokens.filter((r) => r.clientId !== clientId);
  });
  console.log("Revoked OAuth client " + clientId);
});

const tailscale = program.command("tailscale").description("Tailscale Serve/Funnel helpers");
tailscale.command("status").action(async () => {
  try {
    const { stdout } = await execFileAsync("tailscale", ["funnel", "status"]);
    console.log(stdout.trim());
  } catch (error: any) {
    console.error(error?.stderr || error?.message || error);
    process.exitCode = 1;
  }
});
tailscale
  .command("expose")
  .description("Deprecated alias of `lifecycle up`: add only the /token2oauth route, never touching other routes")
  .option("--mode <mode>", "funnel or serve (only used when no :443 listener exists yet)", "funnel")
  .option("--path <path>", "public path (must be /token2oauth)", OWNED_PATH)
  .option("--execute", "apply the plan; without it this is a dry run")
  .action(async (opts) => {
    if (!["funnel", "serve"].includes(opts.mode)) throw new Error("mode must be funnel or serve");
    if ((normalizeBasePath(opts.path) || "/") !== OWNED_PATH) {
      throw new Error(`Refusing to manage ${opts.path}: Token2OAuth only manages its own ${OWNED_PATH} path.`);
    }
    await runLifecycle("up", { mode: opts.mode, execute: Boolean(opts.execute) });
  });

async function printPlan(plan: LifecyclePlan, execute: boolean, controller: LifecycleController) {
  for (const warning of plan.warnings) console.log("note:    " + warning);
  for (const blocker of plan.blockers) console.log("BLOCKED: " + blocker);
  if (!plan.ok) {
    process.exitCode = 1;
    return;
  }
  if (!plan.steps.length) {
    console.log("Nothing to do: already in the requested state.");
    return;
  }
  console.log(execute ? "Executing:" : "Planned commands (dry run; re-run with --execute to apply):");
  for (const step of plan.steps) console.log("  " + renderCommand(step));
  if (!execute) return;
  const report = await controller.execute(plan, { execute: true });
  for (const result of report.results) console.log((result.ok ? "  ok     " : "  FAILED ") + renderCommand(result.step) + (result.error ? " — " + result.error : ""));
  if (!report.ok) {
    console.error(report.error || "lifecycle execution failed");
    process.exitCode = 1;
  } else {
    console.log("Done. Unrelated Tailscale Serve/Funnel routes were verified unchanged.");
  }
}

async function runLifecycle(
  action: "up" | "down",
  opts: { mode?: "funnel" | "serve"; execute?: boolean; keepService?: boolean; keepRoute?: boolean },
) {
  const controller = new LifecycleController(createExecFileRunner());
  const plan = await controller.plan(action, {
    mode: opts.mode,
    keepService: opts.keepService,
    keepRoute: opts.keepRoute,
    invokedFrom: "cli",
  });
  await printPlan(plan, Boolean(opts.execute), controller);
}

const lifecycle = program
  .command("lifecycle")
  .description("Start/stop Token2OAuth and its own /token2oauth Tailscale route; never touches other routes");
lifecycle.command("status").option("--json").action(async (opts) => {
  const controller = new LifecycleController(createExecFileRunner());
  const status = await controller.status();
  if (opts.json) return console.log(JSON.stringify(status, null, 2));
  const r = status.routes;
  console.log("service:   " + status.service.active + (status.service.enabled ? " (" + status.service.enabled + ")" : ""));
  console.log("listener:  " + (r.hostPort || "none") + (r.funnel ? " [Funnel]" : r.listenerExists ? " [Serve only]" : ""));
  console.log("root /:    " + (r.root.present ? r.root.target + (r.root.matchesExpected ? "" : " (unexpected target; left untouched)") : "not mapped"));
  console.log(OWNED_PATH + ": " + r.owned.state + (r.owned.target ? " → " + r.owned.target : ""));
  if (r.foreignMounts.length) console.log("other:     " + r.foreignMounts.join(", ") + " (preserved)");
  for (const problem of status.problems) console.log("problem:   " + problem);
  if (!status.healthy) process.exitCode = 1;
});
lifecycle
  .command("up")
  .description("Start the service and add the /token2oauth route if missing (dry run unless --execute)")
  .option("--mode <mode>", "funnel or serve, only when no :443 listener exists yet")
  .option("--execute", "apply the plan")
  .action(async (opts) => {
    if (opts.mode && !["funnel", "serve"].includes(opts.mode)) throw new Error("mode must be funnel or serve");
    await runLifecycle("up", { mode: opts.mode, execute: Boolean(opts.execute) });
  });
lifecycle
  .command("down")
  .description("Remove only the /token2oauth route and stop the service (dry run unless --execute)")
  .option("--keep-service", "only remove the route")
  .option("--keep-route", "only stop the service")
  .option("--execute", "apply the plan")
  .action(async (opts) => {
    await runLifecycle("down", { keepService: Boolean(opts.keepService), keepRoute: Boolean(opts.keepRoute), execute: Boolean(opts.execute) });
  });

const tools = program.command("tools").description("Inspect upstream tool inventories and the enforced tool policy");
tools.command("refresh [accountId]").description("Run tools/list with each enabled account (or one) and store the inventory").action(async (accountId) => {
  const s = await ensureStore();
  const state = await s.load();
  const targets = state.accounts.filter((a) => a.enabled && (!accountId || a.id === accountId));
  if (!targets.length) throw new Error("no enabled account matched");
  for (const account of targets) {
    const result = await refreshAccountCapabilities(s, account.id);
    console.log((result.ok ? "ok     " : "FAILED ") + account.label + " (" + account.id + "): " + (result.ok ? result.tools.length + " tools" : result.error));
  }
  console.log("Restart is not needed; the running gateway reads inventories from state.");
});
tools.command("list").option("--json").action(async (opts) => {
  const s = await ensureStore();
  const state = await s.load();
  const catalog = toolCatalog(state);
  const denied = new Set(state.config.toolPolicy?.denyTools || []);
  const allow = state.config.toolPolicy?.allowTools ? new Set(state.config.toolPolicy.allowTools) : undefined;
  const rows = catalog.map((t) => ({
    tool: t.name,
    enabled: !denied.has(t.name) && (!allow || allow.has(t.name)),
    replaySafe: (state.config.readOnlyTools || []).includes(t.name),
    accounts: t.accountIds.length,
    schemaDrift: t.schemaDrift,
  }));
  if (opts.json) console.log(JSON.stringify(rows, null, 2));
  else if (rows.length) console.table(rows);
  else console.log("No inventory yet. Run: token2oauth tools refresh");
});
function updatePolicy(s: StateStore, mutate: (policy: ToolPolicy) => void) {
  return s.update((state) => {
    const policy: ToolPolicy = JSON.parse(JSON.stringify(state.config.toolPolicy || {}));
    mutate(policy);
    if (policy.denyTools && !policy.denyTools.length) delete policy.denyTools;
    compileToolPolicy(policy); // throws on an invalid policy, so nothing invalid is persisted
    state.config.toolPolicy = !policy.denyTools && !policy.allowTools && !policy.endpoints?.length ? undefined : policy;
  });
}
tools.command("deny <name>").description("Block a tool for every MCP client").action(async (name) => {
  const s = await ensureStore();
  await updatePolicy(s, (p) => { p.denyTools = [...new Set([...(p.denyTools || []), name])].sort(); });
  console.log("Denied " + name + ". The running gateway enforces it on the next request.");
});
tools.command("allow <name>").description("Remove a tool from the deny list").action(async (name) => {
  const s = await ensureStore();
  await updatePolicy(s, (p) => { p.denyTools = (p.denyTools || []).filter((n) => n !== name); });
  console.log("Allowed " + name + ".");
});
const policyCmd = tools.command("policy").description("Show or replace the full tool policy (JSON)");
policyCmd.command("show").action(async () => {
  const s = await ensureStore();
  console.log(JSON.stringify((await s.load()).config.toolPolicy ?? null, null, 2));
});
policyCmd.command("set <file>").description("Validate and install a policy JSON file (use 'null' content to clear)").action(async (file) => {
  const s = await ensureStore();
  const parsed = JSON.parse(await readFile(file, "utf8"));
  if (parsed !== null) compileToolPolicy(parsed);
  await s.update((state) => { state.config.toolPolicy = parsed === null ? undefined : parsed; });
  console.log(parsed === null ? "Tool policy cleared." : "Tool policy installed and validated.");
});

program
  .command("doctor")
  .description("Diagnose config, credentials, upstream, OAuth, tools and the Funnel route in plain language")
  .option("--json")
  .option("--live", "send one upstream initialize probe and refresh one tool inventory")
  .option("--no-funnel", "skip the read-only systemctl/tailscale inspection")
  .option("--public", "fetch OAuth metadata through the public URL")
  .option("--port <port>", "local gateway port for the health check", "2030")
  .option("--repairs", "preview the allowlisted repairs for current findings (never applied)")
  .action(async (opts) => {
    const s = await ensureStore();
    const pool = new CredentialPool(s);
    const snapshot = await collectDoctorSnapshot(s, pool, {
      healthUrl: "http://127.0.0.1:" + Number(opts.port) + "/healthz",
      live: Boolean(opts.live),
      funnel: opts.funnel !== false,
      publicMetadata: Boolean(opts.public),
    });
    const report = diagnoseDoctorSnapshot(snapshot);
    let repairs: ReturnType<typeof planDoctorRepairs> = [];
    if (opts.repairs) {
      const state = await s.load();
      const candidates: RepairCandidate[] = [];
      if (report.findings.some((f) => f.id === "funnel.mount-missing")) {
        candidates.push({ action: "add-funnel-path-mount", path: state.config.basePath || OWNED_PATH, targetPort: Number(opts.port) });
      }
      repairs = planDoctorRepairs(snapshot, candidates);
    }
    if (opts.json) {
      console.log(JSON.stringify({ report, repairs }, null, 2));
    } else {
      console.log("Token2OAuth doctor: " + report.status);
      for (const check of report.stageChecks) {
        const mark = check.status === "passed" ? "✓" : check.status === "failed" ? "✗" : "?";
        console.log("  " + mark + " " + check.stage.padEnd(12) + check.summary);
      }
      for (const finding of report.findings) {
        console.log("");
        console.log("[" + finding.severity + "] " + finding.title);
        for (const evidence of finding.evidence) console.log("    evidence: " + evidence.observation);
        console.log("    next:     " + finding.action.summary);
      }
      for (const plan of repairs) {
        console.log("");
        console.log("repair preview: " + plan.summary + (plan.applicable ? "" : " (not applicable)"));
        for (const pre of plan.preconditions) console.log("    " + (pre.satisfied ? "✓ " : "✗ ") + pre.name + ": " + pre.reason);
        if (plan.preview) console.log("    before " + JSON.stringify(plan.preview.before) + "\n    after  " + JSON.stringify(plan.preview.after));
        if (plan.applicable && plan.action === "add-funnel-path-mount") console.log("    apply with: token2oauth lifecycle up  (dry run first, then --execute)");
      }
      if (report.stageChecks.some((c) => c.status === "unverified")) {
        console.log("");
        console.log("Unverified stages were not observed. Use --live and --public for upstream, tools and OAuth evidence.");
      }
    }
    if (report.status === "issues") process.exitCode = 1;
  });

const pools = program.command("pools").description("Multi-pool foundations (read-only preview)");
pools.command("preview").description("Show how the current single pool maps to the validated multi-pool schema").action(async () => {
  const s = await ensureStore();
  try {
    const definition = migrateLegacyPool(await s.load());
    console.log(JSON.stringify(definition, null, 2));
    console.log("\nPreview only: state is unchanged and runtime routing still uses the single default pool.");
  } catch (error) {
    if (error instanceof PoolSchemaError) {
      console.error("The current pool cannot be migrated as-is:");
      for (const issue of error.issues ?? [error.message]) console.error("  - " + issue);
      process.exitCode = 1;
      return;
    }
    throw error;
  }
});

const clients = program.command("clients").description("Inspect or configure local MCP clients through their official CLIs");
clients.command("inspect")
  .description("Read local Claude Code and Codex CLI versions and user-level MCP registration names without contacting servers")
  .option("--json", "print machine-readable status")
  .action(async (opts) => {
    const status = await inspectClientConnections();
    if (opts.json) console.log(JSON.stringify({ clients: status, otherSetups: manualClientSetupNotes() }, null, 2));
    else {
      console.table(status.map((row) => ({ client: row.label, installed: row.installed, version: row.version || "", registration: row.registration, servers: row.serverNames.join(", ") })));
      for (const row of status) console.log(`${row.label}: ${row.note}`);
      for (const row of manualClientSetupNotes()) console.log(`${row.client} (${row.support}): ${row.note}`);
    }
  });

clients.command("configure <client>")
  .description("Preview or register Token2OAuth as a user-level MCP server; dry-run unless --apply")
  .requiredOption("--url <url>", "HTTP(S) Token2OAuth MCP endpoint without embedded credentials/query")
  .option("--name <name>", "MCP server name", "token2oauth")
  .option("--apply", "invoke the official client CLI and make the configuration change")
  .action(async (client: LocalMcpClient, opts) => {
    const result = await configureClientConnection({ client, name: opts.name, url: opts.url, apply: Boolean(opts.apply) });
    console.log(`${result.applied ? "Applied" : "Plan"}: ${result.command} ${result.args.map((arg) => /^https?:\/\//i.test(arg) ? "<endpoint-url>" : JSON.stringify(arg)).join(" ")}`);
    if (result.backupPath) console.log(`Redacted MCP-only snapshot: ${result.backupPath}`);
    console.log(result.message);
  });

clients.command("remove <client> <name>")
  .description("Preview or remove a user-level MCP registration through the official CLI; dry-run unless --apply")
  .option("--apply", "invoke the official client CLI and make the configuration change")
  .action(async (client: LocalMcpClient, name: string, opts) => {
    const result = await removeClientConnection({ client, name, apply: Boolean(opts.apply) });
    console.log(`${result.applied ? "Applied" : "Plan"}: ${result.command} ${result.args.map((arg) => JSON.stringify(arg)).join(" ")}`);
    console.log(result.message);
  });

clients.command("restore <client> <backupPath>")
  .description("Preview restoration from a private client-configuration backup; never applies a client change")
  .action(async (client: LocalMcpClient, backupPath: string) => {
    const result = await restoreClientConnection({ client, backupPath });
    console.log(`Plan: ${result.command} ${result.args.map((arg) => JSON.stringify(arg)).join(" ")}`);
    console.log(`Private backup label: ${client} client configuration`);
    console.log(`Removal backup path: ${result.backupPath}`);
    console.log(result.message);
  });

program.parseAsync(process.argv).catch((error) => {
  console.error("token2oauth:", error?.message || error);
  process.exitCode = 1;
});
