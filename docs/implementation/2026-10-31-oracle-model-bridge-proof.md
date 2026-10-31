# Live ROTOXY Oracle model bridge verification

The gateway running immutable release `fa6801d` was tested against the upgraded
private Oracle origin on 2026-10-31. These are live executions, separate from
the mocked route tests.

- `GET /providers/oracle/v1/models` returned HTTP 200 and five namespaced models:
  `oracle/qwen3.5:2b`, `oracle/qwen2.5-coder:3b`, `oracle/deepseek-r1:1.5b`,
  `oracle/tev1:0.8b`, and `oracle/gemma4:e2b`.
- `POST /providers/oracle/v1/chat/completions` returned HTTP 200, the actual model
  `oracle/qwen3.5:2b`, exact content `ROTOXY_API_OK`, and finish reason `stop`.
- The provider reported 20 prompt tokens and 5 completion tokens, 25 total.
- The test issued a temporary gateway token with `model:read` and `model:invoke`
  scopes and a five-minute expiry, then explicitly revoked it in `finally`.
  No credential value was printed or committed.

The origin's initial JSON body handling defect was repaired separately. A second
origin defect allowed a short generation budget to be consumed by internal
reasoning; the small-worker API now explicitly sets `think: false`. It preserves
`length` when the output limit is reached rather than always reporting `stop`.

The origin worker additionally tested successful harmless inference on each of
ora3, ora5, ora6, ora7, and ora8, plus missing/invalid-token rejection, private-URL
rejection, and public example-page extraction. See the private API implementation
report for exact deployment and rollback details. ora1 remains unreachable.

This initial bridge execution was local through the running gateway. Public
Funnel inference and propagated VM attribution require their own recorded checks.
Model discovery alone is not evidence that every listed model was executed.
