# Oracle Python test fixture model defaults — 2026-10-31

The production Oracle pool now defaults to `DEFAULT_MODEL` (`qwen3.5:2b`). The `test_oracle_apply.py` and `test_oracle_model_admin.py` v2 fleet fixtures now import that constant and allow it on each enabled host, so the configured default is actually available under current validation.

The Oracle ops history tests retain `gpt-oss:20b` only as synthetic historical ledger data. Those rows are inserted directly into the temporary SQLite task/event tables rather than submitted through `OraclePool.submit`, which correctly rejects that model for new work. The observed-catalog fixture still lists old model names as read-only discovery data; it does not authorize or admit them.

No production files changed. `test_oracle_pool.py` was not modified.

## Validation

`PYTHONPATH=supervisor python3 -m unittest supervisor.tests.test_oracle_apply supervisor.tests.test_oracle_model_admin supervisor.tests.test_oracle_ops` passed 33 tests. `PYTHONPATH=supervisor python3 -m unittest discover -s supervisor/tests` passed all 520 tests in 152.6 seconds.
