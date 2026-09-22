# Routing

## Explicit routing

Provider header:

```text
X-Rotoxy-Provider: ollama
```

Pool header:

```text
X-Rotoxy-Pool: fast-code
```

Virtual models:

```text
rotoxy/provider/ollama
rotoxy/pool/fast-code
rotoxy/task/research
rotoxy/difficulty/hard
rotoxy/auto
```

URL routes:

```text
/p/ollama/v1/chat/completions
/pool/fast-code/v1/chat/completions
/smart/task/v1/chat/completions
/smart/difficulty/v1/chat/completions
/smart/auto/v1/chat/completions
```

## Task categories

| Category | Typical work |
|---|---|
| general | conversation and uncategorized tasks |
| coding | implementation and refactoring |
| debugging | tests, errors and diagnosis |
| reasoning | planning, architecture and trade-offs |
| research | source synthesis, verification and OSINT-style research |
| data | analytics, SQL, statistics and spreadsheets |
| math-science | mathematics and scientific reasoning |
| extraction | parsing, classification and structured output |
| summarization | compression and document summaries |
| writing | professional writing and editing |
| creative | ideation and creative generation |
| translation | translation and localization |
| vision | images, screenshots and diagrams |
| long-context | long documents, retrieval and cross-document work |
| agentic | multi-step tools, workflows and orchestration |
| security | defensive review, threat modeling and audits |
| devops | shell, cloud, networking, CI/CD and infrastructure |
| documents | PDF/DOCX/PPTX and office-document workflows |

Preview classification:

```bash
rotoxy classify "research this issue, compare sources, and produce a sourced report"
```

## Difficulty

- **easy**: routine or short work
- **medium**: analysis or several steps
- **hard**: architecture, deep debugging, orchestration, comprehensive research or long context

Map classes with `rotoxy configure`.

## Federated same-model routing

Provider model IDs do not need to be identical. Each federated target stores its own provider-specific model ID.

This is useful when the same model family appears under different provider namespaces.

## Failover

A federated pool can use `failover` strategy. In v2, failover selects the first target as the preferred provider; response-driven provider retry is a roadmap item. Account-level 429/401/403 cooldown already works.
