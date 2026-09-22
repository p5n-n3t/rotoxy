# Troubleshooting

## Start here

```bash
rotoxy doctor
```

## Backend does not start

```bash
rotoxy logs 200
pnpm build
rotoxy restart
```

## Client receives 401

The client must send the independent ROTOXY token:

```text
Authorization: Bearer <ROTOXY_TOKEN>
```

Retrieve it locally with `rotoxy token`. If you ran `rotoxy rotate-token`, update every client using the old token.

## Model discovery failure

```bash
rotoxy models --provider PROVIDER_ID
```

Use `--json` only when you need the raw provider response.

## Tailscale endpoint unavailable

```bash
tailscale status
rotoxy status
```

Serve requires Tailnet HTTPS support. Named Services can require administrator definition or approval.

## Worker failure

Run `rotoxy agents`, then invoke the worker's own CLI directly to confirm it is installed and signed in. ROTOXY does not silently replace third-party OAuth sessions.
