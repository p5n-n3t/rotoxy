# Configurable Oracle inference fleet

Implemented on 2026-10-16 from the `d2e354c3dd11002286b824c3a6733e859815ee29` baseline.

`oracle_pool.py` now accepts the exact existing version-1 configuration unchanged and derives its three historical hosts and model policy. A trusted operator may instead provide a private version-2 JSON file. Version 2 keeps the existing bounded inference settings at their current values and adds a `hosts` array:

```json
{
  "version": 2,
  "default_model": "qwen3.5:9b",
  "max_context": 4096,
  "max_predict": 512,
  "max_total_running": 3,
  "max_running_per_host": 1,
  "inference_timeout_seconds": 240,
  "hosts": [
    {
      "id": "ora1",
      "ip": "100.65.151.42",
      "ssh_host": "shh-ora1.ziopsyop.tech",
      "enabled": true,
      "allowedModels": ["qwen3.5:9b", "tev1:0.8b", "gpt-oss:20b"]
    }
  ]
}
```

The config file must remain owner-only (`0600`). Host IDs and SSH aliases use strict hostname-safe character sets; IPs must be IPv4 within the Tailscale CGNAT range `100.64.0.0/10`; host IDs, addresses, and aliases must be unique. Model names are bounded safe identifiers. No shell command, provisioning, download, or deletion is accepted from this configuration. SSH continues to use the fixed remote Python snippets and sends inference input over stdin.

Only enabled hosts contribute to accepted model choices, catalog refresh, queue capacity, and fair scheduling. A task is claimed only by an enabled, healthy host whose refreshed catalog contains the requested model and whose `allowedModels` explicitly includes it. Disabling or removing a host affects new dispatch; stored assignments and history remain visible in the read-only operations snapshot as unconfigured historical hosts. The snapshot derives its current host set from this validated config and safely appends historical IDs found in SQLite.

There is no host-management CLI or admin route in this change. Root integration may wire an owner-only editor for this schema; no live config was edited or any host contacted during implementation. Focused validation: `python3 -m unittest tests.test_oracle_pool tests.test_oracle_ops -q` (27 tests passed).
