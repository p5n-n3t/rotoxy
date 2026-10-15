import express from "express";
import { adminEpoch, parseCookies, type AdminSessions } from "./admin-session.js";
import { adminNav, esc, withCsrf } from "./html.js";
import { page } from "./ui.js";
import { INFERENCE_PROVIDER_PRESETS, InferenceProviderStore, type InferenceProvider } from "./inference-providers.js";
import type { StateStore } from "./store.js";

function readModels(value: unknown): string[] {
  if (typeof value !== "string") throw new TypeError("model allowlist is invalid");
  return value.split(/[\r\n,]+/).map(model => model.trim()).filter(Boolean);
}

/** Authenticated, CSRF-protected operator page for fixed OpenAI/OpenRouter accounts. */
export function createInferenceProviderAdminRouter(store: StateStore, sessions: AdminSessions) {
  const router = express.Router();
  const accounts = new InferenceProviderStore(store);
  router.use("/admin/inference", (_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    next();
  });
  router.use("/admin/inference", async (req, res, next) => {
    const state = await store.load();
    const token = parseCookies(req.headers.cookie).t2o_admin;
    const base = new URL(state.config.publicBaseUrl).pathname.replace(/\/$/, "");
    if (!sessions.valid(token, adminEpoch(state))) return res.redirect(302, `${base}/admin/login?next=${encodeURIComponent(req.originalUrl)}`);
    res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
    res.locals.base = base;
    res.locals.csrf = sessions.csrfToken(token);
    res.locals.token = token;
    next();
  });
  router.use("/admin/inference", express.urlencoded({ extended: false, limit: "32kb" }));
  router.use("/admin/inference", (req, res, next) => {
    if (req.method === "POST" && !sessions.verifyCsrf(res.locals.token, req.body?._csrf)) return res.status(403).json({ error: "csrf_invalid" });
    next();
  });

  router.get("/admin/inference", async (_req, res) => {
    const base = res.locals.base as string;
    const entries = await accounts.listAccounts();
    const cards = entries.map(account => {
      const models = esc(account.allowedModels.join("\n"));
      return `<section class="card"><h2>${esc(account.label)}</h2><p>${esc(INFERENCE_PROVIDER_PRESETS[account.provider].label)} · ${account.enabled ? "Enabled" : "Disabled"} · ${account.allowedModels.length} allowed models${account.allowedModels.length ? "" : " · inference disabled until models are allowed"}</p><form method="post" action="${esc(base)}/admin/inference/update"><input type="hidden" name="id" value="${esc(account.id)}"><label>Label<input name="label" value="${esc(account.label)}" maxlength="80" required></label><label class="toggle"><input type="checkbox" name="enabled" value="1"${account.enabled ? " checked" : ""}>Enabled</label><label>Allowed models, one per line<textarea name="models" maxlength="40000" rows="5">${models}</textarea></label><label>Replacement API token (leave blank to retain)<input type="password" name="token" autocomplete="new-password"></label><button>Save account</button></form><form method="post" action="${esc(base)}/admin/inference/remove"><input type="hidden" name="id" value="${esc(account.id)}"><button class="secondary">Remove account</button></form></section>`;
    }).join("");
    const providerOptions = (Object.keys(INFERENCE_PROVIDER_PRESETS) as InferenceProvider[]).map(provider => `<option value="${provider}">${esc(INFERENCE_PROVIDER_PRESETS[provider].label)}</option>`).join("");
    const body = `<main class="wrap">${adminNav(base, "models")}<h1>Inference providers</h1><p>Credentials are encrypted locally and never shown after saving. Requests use only the fixed official OpenAI or OpenRouter API origin. Empty model allowlists deny inference.</p><div class="grid">${cards}<section class="card"><h2>Add account</h2><form method="post" action="${esc(base)}/admin/inference/add"><label>Provider<select name="provider">${providerOptions}</select></label><label>Label<input name="label" maxlength="80" required></label><label>API token<input type="password" name="token" autocomplete="new-password" required></label><label>Allowed models, one per line<textarea name="models" maxlength="40000" rows="5"></textarea></label><button>Add account</button></form></section></div></main>`;
    res.type("html").send(page("Inference providers", withCsrf(body, res.locals.csrf as string)));
  });

  router.post("/admin/inference/:action", async (req, res) => {
    const body = req.body as Record<string, unknown>;
    try {
      switch (req.params.action) {
        case "add":
          await accounts.addAccount({ provider: body.provider as InferenceProvider, label: typeof body.label === "string" ? body.label.trim() : "", token: body.token as string, allowedModels: readModels(body.models) });
          break;
        case "update":
          await accounts.updateAccount(String(body.id ?? ""), {
            label: typeof body.label === "string" ? body.label.trim() : undefined,
            enabled: body.enabled === "1",
            allowedModels: readModels(body.models),
            ...(typeof body.token === "string" && body.token ? { token: body.token } : {}),
          });
          break;
        case "remove":
          if (!await accounts.removeAccount(String(body.id ?? ""))) return res.status(404).json({ error: "account_not_found" });
          break;
        default: return res.status(404).json({ error: "unknown_action" });
      }
      return res.redirect(303, `${res.locals.base}/admin/inference`);
    } catch { return res.status(400).json({ error: "inference_account_operation_failed" }); }
  });
  return { router, accounts };
}
