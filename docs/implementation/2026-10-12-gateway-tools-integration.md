# Gateway tools integration checkpoint — 2026-10-12

## Base and ownership

This isolated branch starts at integration base `45c3cd33ecc08f9ddb30d324dc00bff2f5fa5c25` (`origin/codex/unified-platform-20261010`). Provider search/extract modules were already present there and were not re-applied. This assignment owns only `src/proxy.ts`, `src/server.ts`, `src/oauth.ts`, `src/cli.ts`, `src/web-tools-config.ts`, `src/analytics-api.ts`, `test/web-gateway.test.mjs`, `test/analytics-api.test.mjs`, and this checkpoint.

## Web tools opt-in

Start the server with `token2oauth serve --web-tools-config /path/to/private-web-tools.json`. The file maps enabled provider names to existing account IDs, declares each provider feature as `supported`, `unsupported`, or `unknown`, and grants tool names to exact OAuth client IDs. Keep the file owner-private (mode `0600` or stricter). It contains no credential values. Example:

```json
{
  "providers": {
    "exa": { "enabled": true, "accountId": "existing-account-id", "features": { "search": "supported", "extract": "supported" } }
  },
  "permissions": { "clients": { "oauth-client-id": ["web_search", "web_extract"] } }
}
```

Absent config disables discovery. A call resolves the selected account's encrypted token just-in-time and requires its stored provider identity to exactly equal the selected adapter (`exa`, `firecrawl`, or `tavily`). Existing generic-bearer accounts are not Exa credentials and fail closed. Discovery filters by OAuth `web:search` / `web:extract` and per-client permission; calls repeat the permission, provider, feature, and identity checks. Provider options and URL/SSRF validation remain in the adapters. Each call selects one provider and makes at most one provider request; no cross-provider retry/fallback is wired.

Provider references: [Exa Search API](https://docs.exa.ai/reference/search), [Firecrawl Search](https://docs.firecrawl.dev/api-reference/endpoint/search) and [Scrape](https://docs.firecrawl.dev/api-reference/endpoint/scrape), [Tavily Search](https://docs.tavily.com/documentation/api-reference/endpoint/search) and [Extract](https://docs.tavily.com/documentation/api-reference/endpoint/extract). Adapter mappings are based on those documented endpoints and existing contract tests, not a live service call. Quota and price remain unknown unless a provider response reports usage; reported usage is retained separately from gateway request counts.

## Analytics and client recovery

`GET /admin/api/v1/analytics` requires the `t2o_admin` session cookie. It projects the recorder's bounded recent gateway events and latest provider-reported usage through `projectAnalytics`; query filters include `from`, `to`, `provider`, `accountId`, `model`, `client`, and `jobId`. The response explicitly identifies global admin scope and says project isolation is unavailable. Provider/model/client/job filters unsupported for gateway request records remain marked unavailable by the projection.

`token2oauth clients restore <client> <backupPath>` validates and previews restoration from an owner-private backup. It prints a human label and the removal-backup path; the command has no apply switch and does not write client configuration.

## Verification and limits

`npm run build` plus the focused gateway/analytics tests exercise mock fetches, scope discovery and denial, caller permissions, provider identity, disabled/missing configuration, no retry, admin authentication, analytics filtering, and global-scope labeling. Provider operation itself remains unverified until an explicitly authorized live credential/call exists. No credentials, live calls, deployment, client changes, or migrations were made.
