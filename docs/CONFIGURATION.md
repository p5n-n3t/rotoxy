# Configuration walkthrough

## First installation

```bash
./install.sh
```

Choose an initial provider, paste one or more account keys, then choose Tailscale Serve, Funnel, or localhost-only exposure.

## Add a provider

```bash
rotoxy configure
```

Choose **Add or replace a provider + rotating accounts**. Every provider receives a provider pool with the same ID.

## Change default provider without changing URL

```bash
rotoxy provider use PROVIDER_ID
```

The backend reloads valid `config.json` changes automatically.

## Create a cross-provider pool

Use `rotoxy configure` → **Create a same-model cross-provider pool**. Select each provider and its model ID, then choose round-robin, random, or failover behavior.

Only compatible wire protocols can share a federated pool.

## Smart routing

Use either **Task-category routing** or **Easy / medium / hard routing**. Every mapping points to a pool and can optionally override its model.

## Endpoint layout

One URL is recommended. Named Tailscale Services are useful when a client cannot add ROTOXY routing headers or virtual model IDs.

## Files

`config.json` contains routing configuration. `secrets.env` contains API keys and is mode 600. See [config.example.json](../config.example.json) for a sanitized example.
