# Oracle model inventory and cleanup — 2026-11-01

Live read-only inventory collected over existing SSH aliases with `BatchMode=yes`, `ConnectTimeout=5`; Ollama `/api/tags`, `/api/ps`, and `/api/show` on loopback; Docker inspect reported only image, state, restart policy, mount paths, and network mode. No credentials or environment values were read. All six hosts responded. Each `/api/ps` returned no loaded inference models. The local pool SQLite snapshot had zero tasks in queued, running, pending, or leased status at preflight.

## Model evidence before authorized removals

Sizes are exact Ollama tag byte counts; parameter counts and architecture come from `/api/show` `model_info`. Digests identify the tags before deletion.

| Host | Tag | Architecture / parameters | Bytes | Digest prefix | Action |
|---|---|---:|---:|---|---|
| ora1 | `gpt-oss:20b` | gptoss / 20,914,757,184 (20.9B) | 13,793,441,244 | `17052f91a42e` | Remove exact requested model |
| ora3 | `llamacpp:9ba9cc2b4e02463b933096090530aef679d534dd91ecc9afadfb2dbfdc59f3c5` | gpt-oss / 20,914,757,184 (20.9B) | 13,793,441,546 | `9ba9cc2b4e02` | Remove verified GPT-OSS 20B alias |
| ora5 | `llamacpp:9ba9cc2b4e02463b933096090530aef679d534dd91ecc9afadfb2dbfdc59f3c5` | gpt-oss / 20,914,757,184 (20.9B) | 13,793,441,546 | `9ba9cc2b4e02` | Remove verified GPT-OSS 20B alias |
| ora1 | `tev1:0.8b` | qwen35 / 752,393,024 (752.39M) | 811,856,202 | `8d11b3146b7f` | Remove duplicate; keep ora8 copy |
| ora3 | `tev1:0.8b` | qwen35 / 752,393,024 (752.39M) | 811,856,202 | `8d11b3146b7f` | Remove duplicate; keep ora8 copy |
| ora5 | `tev1:0.8b` | qwen35 / 752,393,024 (752.39M) | 811,856,202 | `8d11b3146b7f` | Remove duplicate; keep ora8 copy |
| ora6 | `tev1:0.8b` | qwen35 / 772,845,888 (772.85M) | 833,606,657 | `abc31fdb0bf5` | Remove duplicate; keep ora8 copy |
| ora7 | `tev1:0.8b` | qwen35 / 772,845,888 (772.85M) | 833,606,657 | `abc31fdb0bf5` | Remove duplicate; keep ora8 copy |
| ora8 | `tev1:0.8b` | qwen35 / 772,845,888 (772.85M) | 833,606,657 | `abc31fdb0bf5` | Retain one copy |

`llamacpp:<hash>` on ora3/ora5 was not assumed from its tag: its runtime metadata reports the `gpt-oss` architecture and exact same 20,914,757,184 parameter count as ora1's `gpt-oss:20b` tag. It is therefore included as a confirmed GPT-OSS 20B alias. TEV variants differ by digest and parameter count; both are the same `tev1:0.8b` model name/family. The ora8 variant is retained.

## Parameter-size interpretation

- `qwen3.5:2b` is 1,881,825,088 parameters (1.9B).
- `deepseek-r1:1.5b` is 1,777,088,000 parameters (1.8B); metadata architecture is qwen2.
- `qwen2.5-coder:3b` is 3,085,938,688 parameters (3.1B). Treat as an optional near-3B model and slightly above a strict 3B ceiling.
- ora1 `gemma4:e4b` is 7,518,069,290 parameters (7.5B); ora8 `gemma4:e2b` is 4,647,450,147 parameters (4.6B). The suffixes do not match measured sizes. `gemma4:e2b` fits the exceptional <=5B ceiling; `gemma4:e4b` is above it. Neither tag was removed.

Current installed catalog after cleanup (all hosts still had empty `/api/ps`):

| Host | Remaining tags |
|---|---|
| ora1 | `qwen3.5:9b`, `gemma4:e4b`, `qwen2.5-coder:7b` |
| ora3 | `qwen2.5-coder:3b`, `qwen3.5:2b`, `deepseek-r1:1.5b`, `qwen3.5:9b` |
| ora5 | `qwen2.5-coder:3b`, `qwen3.5:2b`, `deepseek-r1:1.5b`, `qwen3.5:9b` |
| ora6 | `qwen3.5:2b`, `qwen2.5-coder:3b`, `deepseek-r1:1.5b`, `qwen3.5:9b` |
| ora7 | `qwen2.5-coder:3b`, `qwen3.5:2b`, `deepseek-r1:1.5b`, `llava:7b`, `llama3.2-vision:latest`, `qwen3.5:9b` |
| ora8 | `wizard-vicuna-uncensored:latest`, `llama2-uncensored:7b`, `starcoder2:7b`, `starcoder2:3b`, `mistral-nemo:latest`, `dolphin-phi:2.7b`, `phi3:mini`, `qwen3.5:2b`, `gemma4:e2b`, `deepseek-r1:1.5b`, `tev1:0.8b`, `qwen2.5-coder:3b`, `qwen3.5:9b` |

Unchanged larger local models are inventoried only, not approved as fast defaults: `qwen3.5:9b` is 8.95B parameters on all six; ora7 also has `llava:7b` (7.24B) and `llama3.2-vision:latest` (10.67B). ora8's retained larger tags include `wizard-vicuna` 6.74B, `llama2-uncensored` 6.74B, `starcoder2:7b` 7.17B, `mistral-nemo` 12.25B, `phi3:mini` 3.82B, and `dolphin-phi:2.7b` 2.78B; `starcoder2:3b` is 3.03B. No out-of-scope tag was deleted.

Observed practical size policy: use `qwen3.5:2b` (1.9B) and `deepseek-r1:1.5b` (1.8B) for the strict <=3B set. `qwen2.5-coder:3b` measures 3.1B, slightly exceeds a strict 3B cutoff, and can be optional under the exceptional <=5B ceiling. `gemma4:e2b` at 4.6B is also within that exceptional ceiling. Availability is uneven: ora1 has none of these remaining small models, ora3/5/6/7 have the shared small set, and ora8 has all three plus Gemma and TEV.

## Post-cleanup result

All 8 authorized tag deletions passed the preflight guard (fresh `/api/ps` empty, exact tag+digest match, and `/api/show` architecture+parameter-count match). After each deletion, the target tag was absent and `/api/ps` remained empty. A second full catalog and `/api/ps` check on all six hosts confirmed absence and zero loaded models. Only the requested GPT-OSS 20B family/aliases and duplicate TEV tags were removed; no Gemma, 9B, other large model, container, or persistent-volume data was deleted. The temporary failed API attempt used POST for `/api/delete`, returned HTTP 405, and did not mutate state; successful retries used Ollama's DELETE method.

## Bootstrap source inspection

Inspected `/opt/jq-worker` filename inventories on all six hosts, excluding `.env*`, tokens, secret/credential-named files, and backups. ora6/ora7/ora8 do not have this path. ora1/ora5 contain only `crawl4ai/docker-compose.yaml`; ora3 has the Oracle API files and Crawl4AI compose. A bounded content scan excluding sensitive-named files, tokens, and backups found no model-pull declarations in `/opt/jq-worker`; only ora3 `/opt/jq-worker/oracle-api/app.py` lines 54 and 61 declare the API allowlist (small models including `tev1:0.8b`, not a pull/bootstrap list). No bootstrap model list was changed because none was found there. This inspection does not claim there are no pull declarations elsewhere on the hosts.
