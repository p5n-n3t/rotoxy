# Anthropic Messages over Amazon Bedrock

ROTOXY provides a provider-pinned Anthropic Messages endpoint at:

```text
POST /providers/claude/v1/messages
```

The adapter uses Anthropic's official `@anthropic-ai/bedrock-sdk`. It supports the newer `AnthropicBedrockMantle` Messages endpoint and the legacy `AnthropicBedrock` client for AWS Bedrock Runtime `InvokeModel`, both with the normal AWS SigV4 credential provider chain. It does not invoke Claude Code, read Claude Code settings, import Bedrock credentials from Claude Code, execute shell commands, or accept an upstream host from a request.

## Operator configuration

Set both trusted environment values on the ROTOXY gateway process:

```text
ROTOXY_BEDROCK_REGION=eu-north-1
ROTOXY_BEDROCK_MODELS=anthropic.claude-opus-5-5,anthropic.claude-sonnet-5
ROTOXY_BEDROCK_TRANSPORT=mantle
```

`ROTOXY_BEDROCK_TRANSPORT` accepts `mantle` or `invoke`; it defaults to `mantle`. The gateway process also needs AWS credentials available through the standard AWS credential chain, with permission to invoke the configured models. The route is disabled with a sanitized HTTP 503 response unless the region, a supported transport, and at least one model are configured. The adapter deliberately rejects `AWS_BEARER_TOKEN_BEDROCK`; this route is configured for AWS chain credentials and SigV4.

Use `mantle` for model IDs supported by the native Messages endpoint, such as `anthropic.claude-opus-5-5`. Use `invoke` where a model is available through Bedrock Runtime `InvokeModel`; Anthropic's legacy integration documents these IDs for example:

```text
global.anthropic.claude-sonnet-4-6
global.anthropic.claude-opus-4-6-v1
global.anthropic.claude-haiku-4-5-20251001-v1:0
```

Use the exact model ID from the AWS/Anthropic documentation and the operator allowlist. Client display suffixes such as `[1m]` are not accepted or stripped by ROTOXY. A model ID being accepted by the local allowlist does not prove the AWS account has model access, that its region supports the ID, or that a requested context size is available.

`ROTOXY_BEDROCK_MODELS` is an operator-owned allowlist. ROTOXY does not infer model access from a model catalog, and a configured model can still be unavailable to the AWS account or selected region. AWS authorization, regional availability, and model access remain provider-side requirements.

## Client authentication

Clients may use either:

```http
x-api-key: <ROTOXY model:invoke token>
```

or:

```http
Authorization: Bearer <ROTOXY model:invoke token>
```

Supplying both is rejected. The token is validated by `ModelCredentialStore.authorizeToken` with the `model:invoke` scope. The admin password, OAuth access tokens, and upstream AWS credentials are not accepted as this gateway token.

## Messages behavior

The request uses the Anthropic Messages JSON shape, including tool definitions, content blocks, stop behavior, usage, and model fields supported by the selected SDK transport and Bedrock model. The selected model must exactly match the configured allowlist. `stream: true` returns Anthropic-compatible Server-Sent Events from the SDK. The legacy SDK adapts Bedrock Runtime's response stream into the Messages stream interface. A disconnected caller aborts the in-flight SDK request; the SDK retry count is set to zero because an interrupted inference may already have been billed or processed. Feature support varies by model and transport.

Request bodies default to a 1 MiB limit (hard maximum 2 MiB), active inference defaults to four concurrent requests (hard maximum 32), output defaults to a 4096 token maximum (hard maximum 65,536), and the end-to-end deadline defaults to 120 seconds (hard maximum 10 minutes). The deadline includes request-body parsing so slow requests cannot occupy a dispatch slot indefinitely. When capacity is full, new calls receive a sanitized 503 response. Provider errors are mapped to generic gateway errors; credential values, signed headers, provider URLs, prompts, and raw SDK error text are not returned to callers.

This endpoint is a model inference API. It does not expose Claude Code's filesystem, shell, MCP, or agent-session tools. Those are separate local-agent or workspace capabilities.

## Sources checked 2026-10-18

- Anthropic, [Claude in Amazon Bedrock (Opus 4.7 and later)](https://platform.claude.com/docs/en/build-with-claude/claude-in-amazon-bedrock): Messages endpoint, Bedrock Mantle, AWS credential chain, model identifiers, and SSE behavior.
- Anthropic, [Claude on Amazon Bedrock legacy](https://platform.claude.com/docs/en/build-with-claude/claude-on-amazon-bedrock-legacy): legacy `InvokeModel` client, model IDs, and supported regions.
- Anthropic, [TypeScript SDK](https://platform.claude.com/docs/en/cli-sdks-libraries/sdks/typescript): official `@anthropic-ai/bedrock-sdk` package and `AnthropicBedrockMantle` client.
- AWS, [APIs supported by Amazon Bedrock](https://docs.aws.amazon.com/bedrock/latest/userguide/apis.html): distinction between Messages API and the legacy Invoke/Converse APIs.

No live Bedrock inference request was issued as part of implementing or testing this adapter.
