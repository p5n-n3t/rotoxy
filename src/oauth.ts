import { page } from "./ui.js";
import { createHash } from "node:crypto";
import type { NextFunction, Request, Response, Router } from "express";
import express from "express";
import {
  ensureMasterKey,
  pkceS256,
  randomToken,
  signAccessToken,
  verifyAccessToken,
  verifyPassword,
} from "./crypto.js";
import type {
  AccessClaims,
  AuthorizationCodeRecord,
  OAuthClient,
  PersistedState,
  RefreshTokenRecord,
} from "./types.js";
import { StateStore } from "./store.js";
import { AdminSessions, adminEpoch, parseCookies } from "./admin-session.js";

const ACCESS_TTL_SECONDS = 60 * 60;
const REFRESH_TTL_SECONDS = 30 * 24 * 60 * 60;
const CODE_TTL_MS = 2 * 60 * 1000;
const SUPPORTED_SCOPES = ["mcp", "jobs:read", "jobs:write", "web:search", "web:extract"] as const;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

function esc(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function validRedirectUri(uri: string): boolean {
  try {
    const parsed = new URL(uri);
    if (parsed.hash) return false;
    if (parsed.protocol === "https:") return true;
    return (
      parsed.protocol === "http:" &&
      (parsed.hostname === "127.0.0.1" ||
        parsed.hostname === "localhost" ||
        parsed.hostname === "::1")
    );
  } catch {
    return false;
  }
}

function oauthError(res: Response, status: number, error: string, description: string) {
  res.status(status).json({ error, error_description: description });
}

export class OAuthService {
  readonly router: Router = express.Router();
  private codes = new Map<string, AuthorizationCodeRecord>();

  constructor(
    private readonly store: StateStore,
    private readonly sessions: AdminSessions,
  ) {
    this.router.get("/.well-known/oauth-protected-resource", this.protectedResource);
    this.router.get("/.well-known/oauth-authorization-server", this.authorizationMetadata);
    this.router.post("/oauth/register", express.json({ limit: "128kb" }), this.register);
    // The consent page must never render inside another site's frame: a
    // signed-in admin could otherwise be clickjacked into approving a client.
    this.router.use("/oauth/authorize", (_req, res, next) => {
      res.setHeader("X-Frame-Options", "DENY");
      res.setHeader("Content-Security-Policy", "frame-ancestors 'none'");
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Referrer-Policy", "no-referrer");
      next();
    });
    this.router.get("/oauth/authorize", this.authorizeGet);
    this.router.post(
      "/oauth/authorize",
      express.urlencoded({ extended: false, limit: "64kb" }),
      this.authorizePost,
    );
    this.router.post(
      "/oauth/token",
      express.urlencoded({ extended: false, limit: "64kb" }),
      this.token,
    );

    // Claude Code 2.1.286 uses the short OAuth endpoint names. Keep these as
    // aliases to the same handlers so PKCE, issuer/resource binding, redirect
    // checks, and token rotation cannot drift between endpoint spellings.
    this.router.post("/register", express.json({ limit: "128kb" }), this.register);
    this.router.use("/authorize", (_req, res, next) => {
      res.setHeader("X-Frame-Options", "DENY");
      res.setHeader("Content-Security-Policy", "frame-ancestors 'none'");
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Referrer-Policy", "no-referrer");
      next();
    });
    this.router.get("/authorize", this.authorizeGet);
    this.router.post(
      "/authorize",
      express.urlencoded({ extended: false, limit: "64kb" }),
      this.authorizePost,
    );
    this.router.post(
      "/token",
      express.urlencoded({ extended: false, limit: "64kb" }),
      this.token,
    );
  }

  /** Drop every pending authorization code (used after an admin rotation). */
  revokeAuthorizationCodes(): void {
    this.codes.clear();
  }

  private pruneCodes(): void {
    const now = Date.now();
    for (const [code, record] of this.codes) {
      if (record.expiresAt <= now) this.codes.delete(code);
    }
  }

  private issuer(state: PersistedState): string {
    return state.config.publicBaseUrl.replace(/\/$/, "");
  }

  private resource(state: PersistedState): string {
    return this.issuer(state) + "/mcp";
  }

  private protectedResource = async (_req: Request, res: Response) => {
    const state = await this.store.load();
    const issuer = this.issuer(state);
    res.json({
      resource: this.resource(state),
      authorization_servers: [issuer],
      scopes_supported: [...SUPPORTED_SCOPES],
      bearer_methods_supported: ["header"],
      resource_name: "ROTOXY MCP Gateway",
    });
  };

  private authorizationMetadata = async (_req: Request, res: Response) => {
    const state = await this.store.load();
    const issuer = this.issuer(state);
    res.json({
      issuer,
      authorization_endpoint: issuer + "/oauth/authorize",
      token_endpoint: issuer + "/oauth/token",
      registration_endpoint: issuer + "/oauth/register",
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      scopes_supported: [...SUPPORTED_SCOPES],
      token_endpoint_auth_methods_supported: ["none"],
      authorization_response_iss_parameter_supported: true,
    });
  };

  private register = async (req: Request, res: Response) => {
    const body = req.body || {};
    const redirectUris = Array.isArray(body.redirect_uris)
      ? body.redirect_uris.map(String)
      : [];
    if (!redirectUris.length || !redirectUris.every(validRedirectUri)) {
      return oauthError(res, 400, "invalid_redirect_uri", "A valid redirect_uris array is required.");
    }
    const method = String(body.token_endpoint_auth_method || "none");
    if (method !== "none") {
      return oauthError(
        res,
        400,
        "invalid_client_metadata",
        "ROTOXY currently registers public PKCE clients using token_endpoint_auth_method=none.",
      );
    }

    const client: OAuthClient = {
      clientId: randomToken(24),
      redirectUris,
      clientName: body.client_name ? String(body.client_name).slice(0, 120) : undefined,
      tokenEndpointAuthMethod: "none",
      createdAt: Date.now(),
    };
    await this.store.update((state) => {
      state.oauthClients.push(client);
      state.oauthClients = state.oauthClients.slice(-100);
    });
    res.status(201).json({
      client_id: client.clientId,
      client_id_issued_at: Math.floor(client.createdAt / 1000),
      client_name: client.clientName,
      redirect_uris: client.redirectUris,
      response_types: ["code"],
      grant_types: ["authorization_code", "refresh_token"],
      token_endpoint_auth_method: "none",
    });
  };

  private validateAuthorize(
    state: PersistedState,
    q: Record<string, any>,
  ): { client: OAuthClient; redirectUri: string; resource: string; scope: string } {
    const clientId = String(q.client_id || "");
    const client = state.oauthClients.find((c) => c.clientId === clientId);
    if (!client) throw new Error("unknown client_id");
    const redirectUri = String(q.redirect_uri || "");
    if (!client.redirectUris.includes(redirectUri)) throw new Error("redirect_uri is not registered");
    if (String(q.response_type || "") !== "code") throw new Error("response_type must be code");
    if (!q.code_challenge || String(q.code_challenge_method || "") !== "S256") {
      throw new Error("PKCE S256 is required");
    }
    const resource = String(q.resource || this.resource(state));
    if (resource !== this.resource(state)) throw new Error("resource does not match this MCP server");
    const requested = [...new Set(String(q.scope || "mcp").split(/\s+/).filter(Boolean))];
    if (!requested.includes("mcp")) throw new Error("mcp scope is required");
    if (requested.some((scope) => !(SUPPORTED_SCOPES as readonly string[]).includes(scope))) throw new Error("unsupported scope requested");
    return { client, redirectUri, resource, scope: requested.join(" ") };
  }

  private authorizeGet = async (req: Request, res: Response) => {
    const state = await this.store.load();
    try {
      const validated = this.validateAuthorize(state, req.query);
      const session = parseCookies(req.headers.cookie)["t2o_admin"];
      const loggedIn = this.sessions.valid(session, adminEpoch(state));
      const csrf = loggedIn ? this.sessions.csrfToken(session) || "" : "";
      const hidden = ["client_id", "redirect_uri", "response_type", "code_challenge", "code_challenge_method", "state", "resource", "scope"]
        .map((name) => '<input type="hidden" name="' + name + '" value="' + esc((req.query as any)[name] || "") + '">')
        .join("");
      res.type("html").send(page("Authorize", `<main class="login"><section class="card"><div class="brand"><div class="logo">T2</div><strong>ROTOXY</strong></div><div class="eyebrow">Authorization request</div><h1>Authorize gateway access</h1>
<p class="muted"><strong>${esc(validated.client.clientName || "MCP client")}</strong> is requesting access to the ROTOXY MCP gateway. Upstream bearer credentials stay on this host and are never returned to the client.</p>
<div class="pill">scope · ${esc(validated.scope)}</div>
<form method="post" action="./authorize">${hidden}
${loggedIn ? '<input type="hidden" name="session_authorized" value="1"><input type="hidden" name="_csrf" value="' + esc(csrf) + '">' : '<label>Gateway admin password</label><input type="password" name="admin_password" autocomplete="current-password" required>'}
<button type="submit">Authorize connection →</button></form>
<div class="foot">OAuth 2.1-style authorization code flow · PKCE S256 · resource-bound token</div></section></main>`));
    } catch (error: any) {
      res.status(400).type("html").send("<h1>Invalid OAuth request</h1><p>" + esc(error.message) + "</p>");
    }
  };

  private authorizePost = async (req: Request, res: Response) => {
    const state = await this.store.load();
    let validated;
    try {
      validated = this.validateAuthorize(state, req.body);
    } catch (error: any) {
      return oauthError(res, 400, "invalid_request", error.message);
    }

    const cookieSession = parseCookies(req.headers.cookie)["t2o_admin"];
    // A signed-in admin session only authorizes when the form also carries the
    // session's CSRF token; otherwise another page could auto-submit consent.
    const sessionOk =
      this.sessions.valid(cookieSession, adminEpoch(state)) &&
      this.sessions.verifyCsrf(cookieSession, req.body._csrf);
    const client = req.ip || "unknown";
    if (!sessionOk) {
      const wait = this.sessions.passwordBlocked(client);
      if (wait) {
        res.setHeader("Retry-After", String(wait));
        return res.status(429).type("html").send("<h1>Too many attempts</h1><p>Authorization is paused for this address. Try again later.</p>");
      }
    }
    if (!sessionOk && !verifyPassword(String(req.body.admin_password || ""), state.admin)) {
      this.sessions.passwordFailed(client);
      return res.status(401).type("html").send("<h1>Authorization denied</h1><p>Incorrect gateway admin password.</p>");
    }

    const code = randomToken(32);
    this.codes.set(code, {
      code,
      clientId: validated.client.clientId,
      redirectUri: validated.redirectUri,
      codeChallenge: String(req.body.code_challenge),
      codeChallengeMethod: "S256",
      resource: validated.resource,
      scope: validated.scope,
      expiresAt: Date.now() + CODE_TTL_MS,
      adminEpoch: adminEpoch(state),
    });
    this.pruneCodes();

    const target = new URL(validated.redirectUri);
    target.searchParams.set("code", code);
    if (req.body.state) target.searchParams.set("state", String(req.body.state));
    target.searchParams.set("iss", this.issuer(state));
    res.redirect(302, target.toString());
  };

  private issueTokens = async (
    state: PersistedState,
    clientId: string,
    resource: string,
    scope: string,
  ) => {
    const key = await ensureMasterKey(this.store.keyPath);
    const now = Math.floor(Date.now() / 1000);
    const claims: AccessClaims = {
      iss: this.issuer(state),
      sub: "oauth-client:" + clientId,
      aud: resource,
      client_id: clientId,
      scope,
      iat: now,
      exp: now + ACCESS_TTL_SECONDS,
      jti: randomToken(12),
    };
    const accessToken = signAccessToken(claims, key);
    const refreshToken = randomToken(48);
    const record: RefreshTokenRecord = {
      tokenHash: sha256(refreshToken),
      clientId,
      resource,
      scope,
      expiresAt: Date.now() + REFRESH_TTL_SECONDS * 1000,
    };
    return { accessToken, refreshToken, record };
  };

  private token = async (req: Request, res: Response) => {
    const state = await this.store.load();
    const grantType = String(req.body.grant_type || "");
    const clientId = String(req.body.client_id || "");

    if (grantType === "authorization_code") {
      const code = String(req.body.code || "");
      const record = this.codes.get(code);
      if (!record || record.expiresAt <= Date.now() || (record.adminEpoch ?? 0) !== adminEpoch(state)) {
        this.codes.delete(code);
        return oauthError(res, 400, "invalid_grant", "Authorization code is invalid or expired.");
      }
      if (
        record.clientId !== clientId ||
        record.redirectUri !== String(req.body.redirect_uri || "")
      ) {
        return oauthError(res, 400, "invalid_grant", "Client or redirect URI mismatch.");
      }
      const verifier = String(req.body.code_verifier || "");
      if (verifier.length < 43 || verifier.length > 128 || pkceS256(verifier) !== record.codeChallenge) {
        return oauthError(res, 400, "invalid_grant", "PKCE verification failed.");
      }
      const resource = String(req.body.resource || record.resource);
      if (resource !== record.resource) {
        return oauthError(res, 400, "invalid_target", "resource mismatch");
      }
      this.codes.delete(code);
      const issued = await this.issueTokens(state, clientId, resource, record.scope);
      await this.store.update((s) => {
        s.refreshTokens.push(issued.record);
        s.refreshTokens = s.refreshTokens.filter((r) => r.expiresAt > Date.now()).slice(-250);
      });
      return res.json({
        access_token: issued.accessToken,
        token_type: "Bearer",
        expires_in: ACCESS_TTL_SECONDS,
        refresh_token: issued.refreshToken,
        scope: record.scope,
      });
    }

    if (grantType === "refresh_token") {
      const rawRefresh = String(req.body.refresh_token || "");
      const tokenHash = sha256(rawRefresh);
      const record = state.refreshTokens.find(
        (r) => r.tokenHash === tokenHash && r.clientId === clientId,
      );
      if (!record || record.expiresAt <= Date.now()) {
        return oauthError(res, 400, "invalid_grant", "Refresh token is invalid or expired.");
      }
      const resource = String(req.body.resource || record.resource);
      if (resource !== record.resource) {
        return oauthError(res, 400, "invalid_target", "resource mismatch");
      }
      const issued = await this.issueTokens(state, clientId, resource, record.scope);
      await this.store.update((s) => {
        s.refreshTokens = s.refreshTokens.filter((r) => r.tokenHash !== tokenHash && r.expiresAt > Date.now());
        s.refreshTokens.push(issued.record);
      });
      return res.json({
        access_token: issued.accessToken,
        token_type: "Bearer",
        expires_in: ACCESS_TTL_SECONDS,
        refresh_token: issued.refreshToken,
        scope: record.scope,
      });
    }

    return oauthError(res, 400, "unsupported_grant_type", "Supported grants: authorization_code, refresh_token.");
  };

  authenticateMcp = async (req: Request, res: Response, next: NextFunction) => {
    const state = await this.store.load();
    const metadata = this.issuer(state) + "/.well-known/oauth-protected-resource";
    const auth = req.header("authorization") || "";
    const match = auth.match(/^Bearer\s+(.+)$/i);
    if (!match) {
      res.setHeader("WWW-Authenticate", 'Bearer resource_metadata="' + metadata + '"');
      return res.status(401).json({ error: "unauthorized" });
    }
    try {
      const claims = verifyAccessToken(match[1], await ensureMasterKey(this.store.keyPath));
      if (claims.iss !== this.issuer(state) || claims.aud !== this.resource(state)) {
        throw new Error("issuer or audience mismatch");
      }
      if (!claims.scope.split(/\s+/).includes("mcp")) throw new Error("missing mcp scope");
      const notBefore = state.security?.accessTokenNotBefore;
      if (notBefore !== undefined && !(Number.isInteger(claims.iat) && claims.iat >= notBefore)) {
        throw new Error("token was revoked by an admin credential rotation");
      }
      (res.locals as any).oauthClaims = claims;
      next();
    } catch (error: any) {
      res.setHeader("WWW-Authenticate", 'Bearer resource_metadata="' + metadata + '", error="invalid_token"');
      return res.status(401).json({ error: "invalid_token", error_description: error.message });
    }
  };
}
