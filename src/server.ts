import { OracleTools } from "./oracle-tools.js";
import express from "express";
import { fileURLToPath } from "node:url";
import { AdminSessions } from "./admin-session.js";
import { OAuthService } from "./oauth.js";
import { CredentialPool } from "./pool.js";
import { McpProxy } from "./proxy.js";
import { StateStore, normalizeBasePath } from "./store.js";
import { TelemetryRecorder } from "./telemetry.js";
import { createSupervisorAdminRouter, SupervisorApi, type SupervisorBackend } from "./supervisor-api.js";
import { createSupervisorRuntime } from "./supervisor-runtime.js";
import { loadWebToolsConfig, type ConfiguredWebTools } from "./web-tools-config.js";
import { createAnalyticsApiRouter } from "./analytics-api.js";

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
  const supervisor = new SupervisorApi(options.supervisorBackend);
  const webTools = options.webTools ?? await loadWebToolsConfig(options.webToolsConfigPath, store);
  const proxy = new McpProxy(store, pool, telemetry, supervisor, options.oracleTools, webTools);
  const ui = new (await import("./ui.js")).AdminUi(store, pool, sessions, { oauth, telemetry });

  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", ["loopback", "linklocal", "uniquelocal"]);

  const router = express.Router();
  router.use(oauth.router);
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

  app.use((error: any, _req: any, res: any, _next: any) => {
    console.error("[token2oauth]", error);
    if (res.headersSent) return;
    res.status(500).json({ error: "internal_error", message: String(error?.message || error) });
  });

  return { app, store, pool, telemetry, sessions, supervisor, webTools };
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
  const { app } = await buildApp(store, { supervisorBackend: options.supervisorBackend ?? runtime, oracleTools: options.oracleTools ?? (options.oraclePool ? new OracleTools({ supervisorCwd: fileURLToPath(new URL("../supervisor/", import.meta.url)) }) : undefined), webToolsConfigPath: options.webToolsConfigPath });
  const host = options.host || process.env.TOKEN2OAUTH_HOST || "127.0.0.1";
  const port = options.port || Number(process.env.TOKEN2OAUTH_PORT || 2030);

  const server = app.listen(port, host, () => {
    console.log("");
    console.log("  Token2OAuth");
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

  if (runtime) server.once("close", () => { void runtime.close(); });

  return { server, store, init, supervisor: runtime };
}
