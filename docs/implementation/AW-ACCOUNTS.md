# ChatGPT & Codex account enrollment checkpoint

Assignment `AW-ACCOUNTS`, branch `codex/rotoxy-agent-account-enrollment-20261016`, from fetched `origin/main` at `2c0bc90f8658c2330f4ad9e0067b3bcaf2343088`.

The `/admin/codex` page is now discoverable from admin Resources as “ChatGPT & Codex accounts.” The copy walks an operator through creating a separate local profile, starting the existing official Codex device-code login, completing the code, and refreshing the reported account, plan, models, and quota. It does not inspect/copy login files, select an account, or launch work. Missing plan, model, and quota data are labeled unknown or not reported. The page also states that no Claude account provider exists in this control plane.

When the adapter is absent, the page gives server-side setup steps using `ROTOXY_CODEX_BINARY`, installation/restart guidance, and the same official documentation links. Root owns the `src/server.ts` wiring for that canonical environment variable; the current main server wiring still reads `TOKEN2OAUTH_CODEX_BINARY`, so root must update it before the empty-state instructions enable the adapter. This worker did not edit the server entry point.

## Official documentation checked 2026-10-16

- The [Codex App Server authentication documentation](https://learn.chatgpt.com/docs/app-server#auth-endpoints) documents `account/login/start` with `chatgptDeviceCode` and notes that an existing local/open-source app using App Server auth may continue. It says App Server authentication has never been permitted for commercial or hosted services and recommends migrating those use cases to Sign in with ChatGPT. It marks externally supplied ChatGPT tokens experimental; this work does not use them.
- OpenAI's [Sign in with ChatGPT documentation](https://developers.openai.com/siwc) documents dedicated integrations for websites and open-source clients, including registration and account/session management. It is linked as the documented path for hosted/commercial products only; no SIWC implementation or capability claim was added here.

## Validation and integration

Tests assert navigation/title, device-code controls and docs, truthful capability cards, unconfigured-server instructions, profile CRUD, and existing auth/CSRF behavior. Keep the existing protected route and form behavior. Root should change the server's Codex binary configuration to `ROTOXY_CODEX_BINARY`; no UI or runtime change enables automatic paid worker dispatch.
