import test from "node:test";
import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pkceS256 } from "../dist/crypto.js";
import { StateStore } from "../dist/store.js";
import { buildApp } from "../dist/server.js";
import { collectDoctorSnapshot } from "../dist/doctor-runtime.js";

const ADMIN = "local-test-admin-password";
const listen = (server) => new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => resolve(server.address()));
});
const close = (server) => new Promise((resolve) => server.close(resolve));

test("OAuth short aliases preserve the standard flow at root and configured prefix", async () => {
  const dir = await mkdtemp(join(tmpdir(), "t2o-rotoxy-oauth-"));
  const priorConfigDir = process.env.TOKEN2OAUTH_CONFIG_DIR;
  const priorHome = process.env.HOME;
  // Isolate both persistent config and home before StateStore construction.
  process.env.TOKEN2OAUTH_CONFIG_DIR = join(dir, "config");
  process.env.HOME = join(dir, "home");
  const store = new StateStore();
  let gateway;
  let metadataServer;
  try {
    await store.init({ adminPassword: ADMIN, basePath: "/token2oauth" });
    const built = await buildApp(store);
    gateway = createHttpServer(built.app);
    const address = await listen(gateway);
    const origin = `http://127.0.0.1:${address.port}`;
    const issuer = origin + "/token2oauth";
    await store.update((s) => { s.config.publicBaseUrl = issuer; });

    for (const endpointPrefix of ["", "/token2oauth"]) {
      const alias = endpointPrefix;
      const metadata = await (await fetch(origin + alias + "/.well-known/oauth-authorization-server")).json();
      const protectedResource = await (await fetch(origin + alias + "/.well-known/oauth-protected-resource")).json();
      assert.equal(metadata.issuer, issuer);
      assert.equal(metadata.authorization_endpoint, issuer + "/oauth/authorize");
      assert.equal(protectedResource.resource, issuer + "/mcp");

      const redirectUri = "http://127.0.0.1/callback";
      const registrationResponse = await fetch(origin + alias + "/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ client_name: "compat-client", redirect_uris: [redirectUri] }),
      });
      assert.equal(registrationResponse.status, 201);
      const client = await registrationResponse.json();
      const verifier = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~";
      const resource = issuer + "/mcp";
      const consent = await fetch(origin + alias + "/authorize", {
        method: "POST",
        redirect: "manual",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: client.client_id,
          redirect_uri: redirectUri,
          response_type: "code",
          code_challenge: pkceS256(verifier),
          code_challenge_method: "S256",
          resource,
          scope: "mcp",
          admin_password: ADMIN,
        }),
      });
      assert.equal(consent.status, 302);
      assert.equal(consent.headers.get("x-frame-options"), "DENY");
      const code = new URL(consent.headers.get("location")).searchParams.get("code");
      assert.ok(code);

      const invalidPkce = await fetch(origin + alias + "/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: client.client_id,
          redirect_uri: redirectUri,
          code,
          code_verifier: "wrong-verifier-that-is-long-enough-to-parse-0000000000000000000",
          resource,
        }),
      });
      assert.equal(invalidPkce.status, 400);

      const tokenResponse = await fetch(origin + alias + "/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: client.client_id,
          redirect_uri: redirectUri,
          code,
          code_verifier: verifier,
          resource,
        }),
      });
      assert.equal(tokenResponse.status, 200);
      const token = await tokenResponse.json();
      assert.equal(token.scope, "mcp");
      assert.ok(token.access_token);

      const rejected = await fetch(origin + "/mcp", {
        method: "POST",
        headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
      assert.equal(rejected.status, 401, "admin password must not be accepted as an access token");

      const refresh = await fetch(origin + alias + "/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "refresh_token", client_id: client.client_id, refresh_token: token.refresh_token, resource }),
      });
      assert.equal(refresh.status, 200);
      const rotated = await refresh.json();
      assert.ok(rotated.access_token);
      assert.notEqual(rotated.refresh_token, token.refresh_token, "refresh tokens rotate");
    }

    let failMetadata = true;
    metadataServer = createHttpServer((req, res) => {
      if (failMetadata) {
        res.writeHead(req.url.includes("protected-resource") ? 200 : 503, { "content-type": "application/json" });
        return res.end(JSON.stringify(req.url.includes("protected-resource")
          ? { resource: "https://fake.invalid/mcp" }
          : { issuer: "https://fake.invalid" }));
      }
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify(req.url.includes("protected-resource")
        ? { resource: issuer + "/mcp" }
        : { issuer }));
    });
    const metaAddress = await listen(metadataServer);
    await store.update((s) => { s.config.publicBaseUrl = `http://127.0.0.1:${metaAddress.port}`; });
    const failedOAuth = await collectDoctorSnapshot(store, null, { publicMetadata: true });
    assert.equal(failedOAuth.oauth.checked, false);
    assert.equal(failedOAuth.oauth.advertisedIssuer, undefined, "HTTP error payload is not authoritative metadata");
    failMetadata = false;
    const observedOAuth = await collectDoctorSnapshot(store, null, { publicMetadata: true });
    assert.equal(observedOAuth.oauth.checked, true);
    assert.equal(observedOAuth.oauth.advertisedIssuer, issuer);
    assert.equal(observedOAuth.oauth.observedResource, issuer + "/mcp");

    const failedFunnel = await collectDoctorSnapshot(store, null, {
      funnel: true,
      runner: async () => { throw new Error("private command detail"); },
    });
    assert.equal(failedFunnel.funnel.checked, false);
    assert.equal(JSON.stringify(failedFunnel).includes("private command detail"), false);
  } finally {
    if (metadataServer?.listening) await close(metadataServer);
    if (gateway?.listening) await close(gateway);
    if (priorConfigDir === undefined) delete process.env.TOKEN2OAUTH_CONFIG_DIR;
    else process.env.TOKEN2OAUTH_CONFIG_DIR = priorConfigDir;
    if (priorHome === undefined) delete process.env.HOME;
    else process.env.HOME = priorHome;
    await rm(dir, { recursive: true, force: true });
  }
});
