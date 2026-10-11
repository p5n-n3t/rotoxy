# Oracle Ollama Pool

The optional local worker pool in `supervisor/snooze/oracle_pool.py` accepts bounded text tasks and sends them to Ollama on three fixed Tailnet VMs. It is independent of the installed gateway and Supervisor service. It makes no model call while idle.

## Boundaries

- The only remote targets are `ora1` (`100.65.151.42`), `ora3` (`100.114.191.111`), and `ora5` (`100.112.7.115`). SSH uses each existing alias and identity, requires batch mode and strict host-key checking, pins the host-key alias to `[shh-oraN.ziopsyop.tech]:6722`, and overrides the destination with the fixed Tailnet IP. It does not modify SSH configuration or expose Ollama ports.
- Remote requests call `http://127.0.0.1:11434` over loopback on the VM. The only operation is Ollama `/api/tags` or `/api/generate`; generation is non-streaming, text-only, `think: false`, `num_ctx: 4096`, and `num_predict: 512`. No model tools, shell, paid cloud, or agent execution are involved.
- Approved model identifiers are `qwen3.5:9b` (default), `tev1:0.8b`, and `gpt-oss:20b`. A catalog refresh records the live model list per host. Claims only select hosts whose latest successful catalog includes the task's chosen model.
- The host pool runs at most three tasks total and one per VM. A SQLite `BEGIN IMMEDIATE` claim transaction and persisted lease fence coordinate multiple CLI/serve processes. Dispatch chooses the least-assigned eligible host and rotates ties.
- A task is limited to 4,000 characters. At most 100 tasks can be queued and 10,000 retained. A result is capped at 16 KiB; catalogs and the event inbox have fixed bounds. Run `cleanup --older-than-days 30` to remove old terminal task records and events; cleanup never deletes queued/running work.
- State defaults to `~/.local/state/token2oauth/oracle-pool/`. Config and SQLite files are mode `0600`; directories are mode `0700`. The SQLite task table contains submitted text and results. The event inbox stores only status, model, host, source reference, token counts, timings, and safe error codes.
- A failed or lost request is not blindly retried. Ollama HTTP 4xx rejections are `failed`; a 5xx response, SSH loss, timeout, malformed response, or vanished worker is `ambiguous`. An ambiguous task requires operator review before a new task is submitted.

## CLI

Run from the `supervisor/` package root:

```sh
python -m snooze.oracle_pool catalog --refresh
python -m snooze.oracle_pool submit --file task.txt --id review:credit-invariants
python -m snooze.oracle_pool run-once
python -m snooze.oracle_pool status --id review:credit-invariants
python -m snooze.oracle_pool results --id review:credit-invariants
python -m snooze.oracle_pool events --after 0 --limit 100
python -m snooze.oracle_pool cleanup --older-than-days 30
python -m snooze.oracle_pool serve
```

Task text can also be read from standard input with `submit --stdin` or `submit --file -`; it is never accepted as a command-line string. `serve` polls the local queue every two seconds and sleeps when it is empty. `run-once` claims and runs up to three ready tasks, returning after those requests settle. Both require a successful `catalog --refresh` first. The catalog command only emits model names and safe connection error codes.

The Python API for local integration is:

```python
pool = OraclePool()
task = pool.submit(text, model="qwen3.5:9b", job_id="stable-event-guidance-id", source="event:123")
pool.status(task["id"])
pool.results(task["id"])
pool.events(after=0, limit=100)
pool.run_once()
```

`job_id` makes handoff idempotent across caller restarts when text, model, and source all match; reuse with different content is rejected. Events have an increasing integer cursor. The caller can persist its own cursor; old events are bounded and may be pruned after 10,000 entries.

## Verification and live review evidence

Fake-transport tests cover private state modes, strict host allowlisting, durable idempotency, model-aware catalog routing, fair three-host spread, cross-instance concurrency limits, safe event contents, explicit cleanup bounds, and crash/timeout ambiguity. Live review results and what they establish are recorded separately under `docs/evidence/`; task prompts and full model responses remain only in the private SQLite state unless explicitly published in sanitized form.
