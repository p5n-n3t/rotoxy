# Oracle cluster: implementation contract

The operator requests two independently usable capabilities, also available
through ROTOXY. Preserve existing working APIs while completing these boundaries.

| Capability | Existing verified interface | Required addition |
| --- | --- | --- |
| Search and bounded extraction | Authenticated public `/search`, `/extract`, `/search/mcp`; six guarded extraction workers; private SearXNG | Shared capacity visibility, comparative search-quality evidence |
| Model inference | Public `/models/mcp`, `/v1/models`, `/v1/chat/completions`; ROTOXY `/providers/oracle/v1`; separate durable Oracle MCP queue | Durable dataset partition/collection and shared leases across consumers |

The two MCP surfaces may share one process and authentication infrastructure.
They must advertise different tools and capacity. Two processes or DNS names
are not required merely to establish separate capabilities. Keep credentials
scoped and do not assume a client accepts bearer tokens when it requires OAuth.
ROTOXY's existing OAuth boundary remains available to those clients.

## Model placement

Normal dispatch favors shared small models on eligible hosts: general text and
bounded extraction/classification, with optional coding specialization. Verify
actual parameter counts rather than trusting model tag suffixes. Fresh inventory
reports qwen3.5:2b as 1.9B, deepseek-r1:1.5b as 1.8B, and qwen2.5-coder:3b as 3.1B. The latter belongs in
the optional tier under the operator's strict normal 3B preference. ORA8's
gemma4:e2b reports 4.6B and can be an exceptional specialist. ORA1's gemma4:e4b
reports 7.5B and must not enter dispatch under the 5B ceiling.

Keep one TEV installation on ORA8 for optional experiments. Ordinary queueing,
round-robin/least-busy selection, health checks, capacity and retries are code;
they do not require a decision-model inference. Do not activate TEV automatically
or load it on every node. Model planning can be added only after a measured
quality/cost benefit and with ordinary policy validation of its output.

## Scheduling and large datasets

Distribute equivalent independent chunks fairly among healthy eligible nodes.
Capacity, task capability and completion speed take precedence over equal task
counts. Default to one model inference per host, bounded context/output, and
backpressure; reserve host resources for search/extraction and OpenWebUI too.
Two API processes must not each independently assume they own a free host slot.

Gigabyte inputs remain data files or streams. Parse, filter, hash and partition
with ordinary code. Send only bounded task-specific records to models, retain
chunk IDs and checkpoints, validate output schemas, and merge deterministic
results. Use code alone for jobs that do not need an LLM. A small-model queue
is not a general coding agent with shell, repository and review capabilities.

## Search truth

Crawl4AI is a crawling/browser component; it is not a web index. Existing SearXNG
aggregates external search sources and does not create an independent web index.
Self-hosted search/extraction can replace useful portions of vendor APIs, but
must not claim Exa/Firecrawl feature, quality or availability equivalence without
comparative evidence. Native tool-assisted web research requires an explicit
search/fetch/model workflow; a plain model response has no automatic web access.

## Acceptance

Verify six-host inventory and guarded model removals first. Verify each MCP's
initialization, tool discovery, authentication rejection and actual result.
Measure overlapping work and selected hosts; reject private extraction targets.
Test overload, host loss and recovery without duplicate mutating execution.
Keep restart-safe tasks and artifacts. Browser UI verification remains separate
from API/model tests. Do not mark this contract implemented from endpoint names.

## Current proof

All six hosts responded to fresh inventory. Cleanup commit `d5b22ff` records
three removed GPT-OSS 20B tags/verified aliases and five removed TEV duplicates.
ORA8 retains one TEV copy. ORA1 subsequently downloaded qwen3.5:2b and
deepseek-r1:1.5b; a direct bounded generation on qwen3.5:2b returned exact
`ORA1_SMALL_OK` with HTTP 200 and finish reason `stop` in 11.97 seconds.
ORA1 has not yet been enabled in the durable pool configuration. Subsequent
six-host API tests prove routing through the independent model API, not
dispatch through that older queue.

Separate search/model MCP endpoints and guarded six-node extraction are now
deployed and live-tested. See `2026-11-01-oracle-live-verification.md` for
request overlap, worker attribution and rollout evidence. Durable large-dataset
partition/collection and shared capacity leases across all clients remain
required. ORA1 remains disabled in the older durable queue because historical
ambiguous task outcomes block configuration application; it is enabled in the
separate model API. Do not conflate these execution paths.
