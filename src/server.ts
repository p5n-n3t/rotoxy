import { createRunnerAdminRouter } from "./runner-admin.js";
import { createOracleModelAdminRouter } from "./oracle-model-admin.js";
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { createControlledBatchAdminRouter } from "./controlled-batch-admin.js";
import { createPrivateServiceAdminRouter } from "./private-service-admin.js";
import { AgentWorkspaceService, createAgentWorkspaceRouter } from "./agent-workspace.js";
import { renderAgentWorkspace } from "./agent-workspace-ui.js";
import { createJobsAdminRouter } from "./jobs-admin.js";
import { createOracleFleetAdminRouter } from "./oracle-fleet-admin.js";
import { createProviderHubRouter } from "./provider-hub.js";
import { createInferenceProviderAdminRouter } from "./inference-provider-admin.js";
import { createResourceRoutingAdminRouter } from "./resource-routing-admin.js";
import { createCommandWorkspaceRouter } from "./command-workspace.js";
import { createUnifiedModelApi } from "./unified-model-api.js";
import { createProviderPathApi } from "./provider-paths.js";
import { createBedrockMessagesRouter } from "./bedrock-messages.js";
import { createCloudflareRouter } from "./cloudflare-admin.js";
import { OracleTools } from "./oracle-tools.js";
import express from "express";
import { join } from "node:path";
import { CodexProfiles } from "./codex-profiles.js";
import { createResourceConnectionsRouter } from "./resource-connections.js";
import { fileURLToPath } from "node:url";
import { AdminSessions } from "./admin-session.js";
import { OAuthService } from "./oauth.js";
import { CredentialPool } from "./pool.js";
import { McpProxy } from "./proxy.js";
import { StateStore, normalizeBasePath } from "./store.js";
import { TelemetryRecorder } from "./telemetry.js";
import { createSupervisorAdminRouter, SupervisorApi, type SupervisorBackend } from "./supervisor-api.js";
import { createSupervisorRuntime } from "./supervisor-runtime.js";
import { createAgentWorkspaceAccessRouter } from "./agent-workspace-access.js";
import { liveWebToolsConfig, type ConfiguredWebTools } from "./web-tools-config.js";
import { createAnalyticsApiRouter } from "./analytics-api.js";
import { createModelGateway } from "./model-gateway.js";
import { createControlPlaneAdminRouter } from "./control-plane-admin.js";

export interface ServerOptions {
  host?: string;
  port?: number;
  /** Inject the durable bridge supplied by the supervisor integration. */
  supervisorBackend?: SupervisorBackend;
  /** Opt-in path to a private supervisor runtime JSON policy file. */
  supervisorConfigPath?: string;
  oracleTools?: OracleTools;
  oraclePool?: boolean;
  /** Explicit path to an owner-private, credential-free provider/account mapping. */
  webToolsConfigPath?: string;
  webTools?: ConfiguredWebTools;
}

export async function buildApp(store = new StateStore(), options: Pick<ServerOptions, "supervisorBackend" | "oracleTools" | "webTools" | "webToolsConfigPath"> = {}) {
  await store.init();
  const state = await store.load();
  const sessions = new AdminSessions();
  // Bounded, in-memory, payload-free telemetry: request/attempt/probe events.
  const telemetry = new TelemetryRecorder({ capacity: 2000, capturePayloads: false });
  const pool = new CredentialPool(store);
  pool.telemetry = telemetry;
  const oauth = new OAuthService(store, sessions);
  const modelGateway = createModelGateway(store);
  const supervisor = new SupervisorApi(options.supervisorBackend);
  const webTools = options.webTools ?? liveWebToolsConfig(options.webToolsConfigPath ?? join(store.dir, "web-tools.json"), store);
  const codexBinary = process.env.ROTOXY_CODEX_BINARY ?? process.env.TOKEN2OAUTH_CODEX_BINARY;
  const codexProfiles = codexBinary ? new CodexProfiles({ codexBinary, configDir: store.dir }) : undefined;
  const agentWorkspace = new AgentWorkspaceService(store, options.supervisorBackend);
  const proxy = new McpProxy(store, pool, telemetry, supervisor, options.oracleTools, webTools, { service: agentWorkspace, backend: options.supervisorBackend });
  const ui = new (await import("./ui.js")).AdminUi(store, pool, sessions, { oauth, telemetry });

  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", ["loopback", "linklocal", "uniquelocal"]);

  const router = express.Router();
  router.use(oauth.router);
  const cloudflare = createCloudflareRouter(store, sessions, modelGateway.credentials);
  const unifiedModelApi = createUnifiedModelApi(store, { cloudflareAdapter: cloudflare.adapter });
  router.use(createBedrockMessagesRouter(store));
  router.use(createProviderPathApi(unifiedModelApi.router));
  router.use(unifiedModelApi.router);
  router.use(modelGateway.router);
  router.use(cloudflare.router);
  router.use(createInferenceProviderAdminRouter(store, sessions).router);
  router.use(createProviderHubRouter(store, sessions));
  router.use(createControlledBatchAdminRouter(store, sessions).router);
  router.use(createPrivateServiceAdminRouter(store, sessions).router);
  router.use(createOracleFleetAdminRouter(store, sessions).router);
  const localBinary = (paths: (string | undefined)[]) => [...new Set(paths.filter((path): path is string => Boolean(path && existsSync(path))).map(path => realpathSync(path)))];
  router.use(createRunnerAdminRouter(store, sessions, { configPath: join(store.dir, "runner-profiles.json"), trustedExecutables: {
    claude: localBinary([process.env.ROTOXY_CLAUDE_BINARY, join(homedir(), ".config/nvm/versions/node/v26.3.1/bin/claude"), "/usr/local/bin/claude"]),
    hermes: localBinary([process.env.ROTOXY_HERMES_BINARY, join(homedir(), ".local/bin/hermes")]),
    opencode: localBinary([process.env.ROTOXY_OPENCODE_BINARY, join(homedir(), ".opencode/bin/opencode"), "/usr/local/bin/opencode"]),
  }}).router);
  router.use(createOracleModelAdminRouter(store, sessions).router);
  router.use(createResourceRoutingAdminRouter(store, sessions).router);
  router.use(createAgentWorkspaceAccessRouter(store, sessions, options.supervisorBackend));
  router.use(createAgentWorkspaceRouter(store, sessions, agentWorkspace, renderAgentWorkspace));
  router.use(createCommandWorkspaceRouter(store, sessions, options.supervisorBackend));
  router.use(createJobsAdminRouter(store, sessions, options.supervisorBackend));
  router.use(createControlPlaneAdminRouter(store, sessions, modelGateway.credentials, fileURLToPath(new URL("../supervisor/", import.meta.url)), codexProfiles, modelGateway.snapshot));
  router.use(createResourceConnectionsRouter(store, sessions));
  router.use(createAnalyticsApiRouter(store, sessions, telemetry));
  router.use(createSupervisorAdminRouter(store, sessions, options.supervisorBackend));
  router.use(ui.router);
  router.all(
    "/mcp",
    express.raw({ type: "*/*", limit: "32mb" }),
    oauth.authenticateMcp,
    proxy.handler,
  );

  const basePath = normalizeBasePath(state.config.basePath);
  if (basePath) app.use(basePath, router);
  // Also accept unprefixed routes. This makes Tailscale --set-path work whether
  // the reverse proxy strips the mount prefix or forwards it.
  app.use(router);

  app.use((_req, res) => {
    res.status(404).json({ error: "not_found" });
  });

  app.use((_error: any, _req: any, res: any, _next: any) => {
    console.error("[rotoxy] request failed");
    if (res.headersSent) return;
    res.status(500).json({ error: "internal_error" });
  });

  return { app, store, pool, telemetry, sessions, supervisor, webTools, modelGateway, codexProfiles, agentWorkspace };
}

export async function startServer(options: ServerOptions = {}) {
  const store = new StateStore();
  const init = await store.init();
  const runtime = options.supervisorConfigPath ? await createSupervisorRuntime({
    configPath: options.supervisorConfigPath,
    configDir: store.dir,
    supervisorCwd: fileURLToPath(new URL("../supervisor/", import.meta.url)),
    store,
  }) : undefined;
  const { app, codexProfiles, agentWorkspace } = await buildApp(store, { supervisorBackend: options.supervisorBackend ?? runtime, oracleTools: options.oracleTools ?? (options.oraclePool ? new OracleTools({ supervisorCwd: fileURLToPath(new URL("../supervisor/", import.meta.url)) }) : undefined), webToolsConfigPath: options.webToolsConfigPath });
  const host = options.host || process.env.TOKEN2OAUTH_HOST || "127.0.0.1";
  const port = options.port || Number(process.env.TOKEN2OAUTH_PORT || 2030);

  const server = app.listen(port, host, () => {
    console.log("");
    console.log("  ROTOXY");
    console.log("  ───────────────────────────────────────────");
    console.log("  Local:  http://" + host + ":" + port);
    void store.load().then((state) => {
      console.log("  Public: " + state.config.publicBaseUrl);
      console.log("  MCP:    " + state.config.publicBaseUrl.replace(/\/$/, "") + "/mcp");
      console.log("  Admin:  " + state.config.publicBaseUrl.replace(/\/$/, "") + "/admin");
      console.log("  Pool:   " + state.config.strategy);
      if (init.adminPassword) {
        console.log("");
        console.log("  NEW ADMIN PASSWORD");
        console.log("  " + init.adminPassword);
        console.log("  Save this now. It will not be shown by the server again.");
      }
      console.log("");
    });
  });

  const workspaceReconciler = options.supervisorBackend || runtime ? agentWorkspace.createReconciler() : undefined;
  workspaceReconciler?.start();
  server.once("close", () => { workspaceReconciler?.stop(); });
  if (codexProfiles) server.once("close", () => { void codexProfiles.close(); });
  if (runtime) server.once("close", () => { void runtime.close(); });

  return { server, store, init, supervisor: runtime };
}
