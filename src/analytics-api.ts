import express, { type Request, type Response } from "express";
import { projectAnalytics, type AnalyticsFilters } from "./analytics.js";
import { adminEpoch, AdminSessions, parseCookies } from "./admin-session.js";
import type { StateStore } from "./store.js";
import type { TelemetryRecorder } from "./telemetry.js";

function queryNumber(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^\d{1,16}$/.test(value)) throw new RangeError("invalid time filter");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new RangeError("invalid time filter");
  return parsed;
}

function dimension(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > 160 || !value.trim()) throw new RangeError("invalid dimension filter");
  return value.trim();
}

export function createAnalyticsApiRouter(store: StateStore, sessions: AdminSessions, telemetry: TelemetryRecorder) {
  const router = express.Router();
  router.get("/admin/api/v1/analytics", async (req: Request, res: Response) => {
    const state = await store.load();
    const session = parseCookies(req.headers.cookie)["t2o_admin"];
    if (!session || !sessions.valid(session, adminEpoch(state))) return res.status(401).json({ error: "admin_session_required" });
    try {
      const filters: AnalyticsFilters = {
        from: queryNumber(req.query.from), to: queryNumber(req.query.to),
        provider: dimension(req.query.provider), accountId: dimension(req.query.accountId),
        model: dimension(req.query.model), client: dimension(req.query.client), jobId: dimension(req.query.jobId),
      };
      const projection = projectAnalytics({ gatewayEvents: telemetry.recent({ limit: 2000 }), providerUsage: telemetry.latestProviderUsage() }, { filters });
      res.setHeader("Cache-Control", "no-store");
      return res.json({ scope: "global-admin-gateway-metrics", projectIsolation: false, projection });
    } catch {
      return res.status(400).json({ error: "invalid_analytics_filter" });
    }
  });
  return router;
}
