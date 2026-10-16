# Trusted claimed-operation dispatch (checkpoint)

The worker now offers an operation-specific adapter only after a structurally valid durable claim. For `chat_session`, the operation factory can reject an unregistered binding; when it is absent, the existing injected `adapterFactory` behavior remains the fallback. The runtime factory checks the claimed account, registered session, and exact configured model before constructing the production LightSprint adapter.

The provider adapter still evaluates the global `lightsprint_api` tool policy first. If that policy denies a mutation, only `sendMessage` may consult the optional trusted permit, and only for an exact `POST /api/agent-sessions/{sessionId}/chat` request with precisely `message` and `clientMessageId`. The runtime captures those values from the claimed operation, consumes the permit synchronously before creating the provider client, and never restores it. This does not change policy for raw MCP, guidance, or other methods.

Checkpoint status: focused regression tests cover claim-gated adapter selection, rejecting a declined operation binding, exact chat request matching, one-use replay denial, and continued denial of other mutations. Build and focused test results are pending; this checkpoint is intentionally incomplete until those checks run.

Integration follow-up: the incomplete checkpoint was repaired by the integration lead: constructor option retention, TypeScript input narrowing, permit invalidation on first attempt, and permit enforcement even under an independently permissive raw policy. Full regression and post-copy UI checks are recorded in the operator-controls release report.
