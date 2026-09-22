# Security

ROTOXY separates three credential classes:

1. **ROTOXY client token** authenticates clients to the gateway.
2. **Provider API keys** authenticate ROTOXY to API providers.
3. **OAuth/subscription sessions** remain owned by official third-party CLIs.

ROTOXY does not print provider keys in normal status output and does not copy OAuth tokens from CLI stores.

## Files

- `~/.config/rotoxy/token`: gateway client token
- `~/.config/rotoxy/secrets.env`: provider API keys
- `~/.config/rotoxy/config.json`: routing configuration
- `~/.local/state/rotoxy/`: logs, PID and usage counters

The installer uses restrictive permissions for secret-bearing files.

## Network

The backend binds to loopback by default. Tailscale provides HTTPS exposure.

**Serve** is preferred when all clients belong to the Tailnet. **Funnel** exposes the endpoint publicly, so the ROTOXY client token remains mandatory.

## Revoke a leaked client token

```bash
rotoxy rotate-token
```

This revokes the old ROTOXY client credential. It does not rotate or revoke upstream provider credentials.

Do not open a public issue containing API keys, OAuth tokens, private Tailnet names, or secret-bearing logs.
