# Provider connection modes — 2026-10-18

## Delivered source

The server now mounts a distinct direct-provider routing layer beside the canonical `/mcp` workspace interface. It shares the existing model-token authorization and provider credential stores rather than starting another gateway or Funnel.

Direct OpenAI-compatible paths cover Ollama, Cloudflare Workers AI, OpenAI and OpenRouter. Saved custom OpenAI-compatible provider IDs automatically receive their own paths; opaque IDs retain their case. Catalog responses are filtered to the selected namespace, and a different provider's model prefix is rejected before inference dispatch. Unknown custom providers fail without a fallback call. Catalog assembly can still refresh Ollama metadata when serving another provider's filtered model list; inference is not sent to another provider.

The opt-in Claude/Bedrock route uses the MIT-licensed official `@anthropic-ai/bedrock-sdk` version 0.35.0. It implements native Messages JSON and SSE, including tool content, using the fixed regional Bedrock Mantle host and standard AWS credentials. It accepts a scoped ROTOXY model token through either `x-api-key` or bearer authentication, rejects conflicting credentials, disables SDK retries, and bounds bodies, concurrency, output tokens and deadlines. It never reads Claude Code settings or executes Claude Code tools. No real Bedrock inference was launched in this increment.

The Oracle MCP metadata adapter now accepts validated host IDs from the trusted pool backend rather than silently restricting output to the original three hosts. The regression fixture includes ORA6 and a future configured worker; request callers still cannot choose an arbitrary SSH destination through this metadata projection. This does not activate a pending fleet configuration or resolve historical ambiguous operations.

## Verification

- Local TypeScript build passed.
- The combined local provider, Bedrock, Oracle, unified-model and Codex-profile checks passed 46/46 before adding the custom-provider regression.
- Production dependency audit reported zero vulnerabilities. The lockfile adds the official SDK and its dependency graph; no existing locked package version changed or disappeared.
- ORA5 built the source and ran the complete Node suite in an isolated Node 22/Python container, restricted to three CPUs and 4 GiB. Regression execution had external networking disabled. The final complete run passed **467/467**, with zero failures, cancellations or skips, in 26.210 seconds. Its first run exposed a test fixture modifying the fixed `custom-` prefix instead of the opaque ID's case; that fixture was corrected before the final complete run.
- Private remote evidence: `/tmp/rotoxy-direct-provider-apSSEScE/build.log` and `node-tests-final.log`. The QA image is `rotoxy-qa-node22-python`, built from pinned official Node image digest `sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392`, with Python/Git/SSH test dependencies. It does not mount production credentials, the Docker socket, or application state.

## Deployment and remaining acceptance

This is a source implementation, not a production rollout. The installed gateway, pool and monitor were inactive when checked; this increment did not restart them or change Funnel configuration. Bedrock remains opt-in and requires an explicit region, model allowlist and authorized AWS credential chain in the gateway environment. Configuring an allowlist does not prove AWS model entitlement.

The workspace session/job resource allowlist and its inheritance rules are documented in the connection contract. The heterogeneous dispatch and selection interface still need implementation and execution acceptance. Direct inference paths for saved Codex profiles and Oracle workers, and provider-scoped workspace MCP surfaces for LightSprint and CLI agents, are not claimed by this delivery. A named external application such as Termani still needs an actual compatibility test; Messages support alone does not prove its setup workflow succeeds.

The runtime is not replaced here. Existing installed runtime/state backups remain applicable; no database migration or credential transfer was performed. Reverting this source increment must also revert its SDK dependency and server imports together.
