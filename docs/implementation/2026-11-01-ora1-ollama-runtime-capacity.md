# ora1 Ollama runtime capacity — 2026-11-01

## Change

Added only these three environment entries to the existing `ollama` service in `/www/dk_project/dk_app/ollama_and_openwebui/ollama_and_openwebui/docker-compose.yml`:

```yaml
OLLAMA_NUM_PARALLEL: "1"
OLLAMA_MAX_LOADED_MODELS: "1"
OLLAMA_CONTEXT_LENGTH: "4096"
```

The Compose document parsed before and after; removing the `ollama.environment` mapping from both parsed documents made the documents equal. `docker compose config --quiet` passed. Compose SHA-256 changed from `6f4f4abac4243bcf999aba58daf827c1396296159c63ba199a3dae5ec8285864` to `ba98cfa607ab3901841e345896911ee23d1a518bdf8696fb273f80a26536d099`.

Before editing, saved an owner-private (`/root` directory mode 0700, files mode 0600) copy of the Compose file and sanitized prior container/image metadata at:

- `/root/rotoxy-ora1-ollama-20261101T161208415599Z/docker-compose.yml.before`
- `/root/rotoxy-ora1-ollama-20261101T161208415599Z/prior-container-image-metadata.json`

The local `ollama/ollama` tag resolved to the running container's prior image ID, `sha256:2a6e883b917fc543389599dae79918f5cac9e1438890506982f44aa4f5625d01`. Rechecked zero local pool tasks in queued/running/pending/leased states and an empty ora1 `/api/ps`, then ran only `docker compose up -d --no-deps --pull never ollama`. The Ollama container ID changed from `b5c7bf342b2c6a5e2c9d6c109ff37ab9f6474219352ac7cbd7165dba27096e0e` to `5c86b58e8e92ca8ec5993d356740ed7491aa3494f597dabe725a9ae7658b39d7`; its image ID did not change. The OpenWebUI container ID stayed `387744eef53d781f5b4ff55c6e33b4573f37def008793d118629c362b9e10a92` and remained running. No image pull/update occurred, and no model or persistent-volume data changed.

## Verification

- Ollama container running; `/api/version` returned `0.35.0`.
- Container runtime environment contains the requested values plus the existing `OLLAMA_HOST=0.0.0.0:11434`.
- The final `/api/ps` check is empty; no model remains loaded.
- Local pool active-task count was zero before recreate and before each inference.
- `qwen3.5:2b` (1.9B) completed an exact-marker request with `think:false`, `num_predict=64`, `num_ctx=4096`, temperature 0, and request `keep_alive=0`. It returned exactly `ORA1_RUNTIME_CAP_OK` in 6.762 seconds, with 29 prompt tokens and 6 generated tokens. `/api/ps` was empty immediately afterward.
- The first bounded request used the same model/context with `num_predict=32` and default thinking behavior. It completed in 7.88 seconds, generated 32 tokens, and returned an empty final `response`; it did not verify the marker. One explicitly authorized follow-up with thinking disabled returned the marker as recorded above.

## Rollback

After confirming no pool work or active inference, restore the saved Compose bytes with owner `root:root` and mode 0755, then recreate only `ollama` from that Compose file with `--no-deps --pull never`. The backed-up metadata records the prior image ID; verify the local `ollama/ollama` tag still resolves to it before rollback. If the tag moved, use a temporary Compose override pinned to the recorded image ID. Do not start dependencies or recreate OpenWebUI.
