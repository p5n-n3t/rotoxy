import express from "express";
import type { StateStore } from "./store.js";
import { AdminSessions, adminEpoch, parseCookies } from "./admin-session.js";
import { adminNav, esc } from "./html.js";
import { page } from "./ui.js";

type LandingKey = "activity" | "settings";
interface LandingLink { label: string; href: string; description: string }

const LANDINGS: Record<LandingKey, { title: string; description: string; links: LandingLink[] }> = {
  activity: {
    title: "Activity",
    description: "Review jobs, supervisor health and diagnostics.",
    links: [
      { label: "Jobs", href: "/admin/jobs", description: "Inspect job queue and recent work." },
      { label: "Supervisor", href: "/admin/supervisor", description: "Review supervisor state and controls." },
      { label: "Diagnostics", href: "/admin/diagnostics", description: "Review health checks and diagnosed configuration." },
    ],
  },
  settings: {
    title: "Settings",
    description: "Manage security, routing and tool access.",
    links: [
      { label: "Security", href: "/admin/security", description: "Manage administrator security settings." },
      { label: "Routing", href: "/admin/routing", description: "Review resource routing and access policy." },
      { label: "Tool access", href: "/admin/tools", description: "Review enabled tools and their access policy." },
    ],
  },
};

export function renderAdminLanding(base: string, key: LandingKey): string {
  const landing = LANDINGS[key];
  const cards = landing.links.map((link) => `<section class="card"><h2><a href="${esc(base)}${esc(link.href)}">${esc(link.label)}</a></h2><p>${esc(link.description)}</p></section>`).join("");
  return page(landing.title, `<main class="wrap">${adminNav(base, key)}<header class="hero"><h1>${esc(landing.title)}</h1><p class="lead">${esc(landing.description)}</p></header><section class="grid" aria-label="${esc(landing.title)} pages">${cards}</section></main>`);
}

/** Authenticated navigation landing pages that link only to mounted admin views. */
export function createAdminNavigationRouter(store: StateStore, sessions: AdminSessions) {
  const router = express.Router();
  for (const key of ["activity", "settings"] as const) {
    router.get(`/admin/${key}`, async (_req, res) => {
      res.setHeader("Cache-Control", "no-store");
      const state = await store.load();
      const token = parseCookies(_req.headers.cookie).t2o_admin;
      if (!sessions.valid(token, adminEpoch(state))) {
        return res.redirect(302, state.config.publicBaseUrl.replace(/\/$/, "") + "/admin/login");
      }
      const base = new URL(state.config.publicBaseUrl).pathname.replace(/\/$/, "");
      return res.type("html").send(renderAdminLanding(base, key));
    });
  }
  return router;
}
