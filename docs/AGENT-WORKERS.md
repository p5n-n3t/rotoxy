# Agent workers and OAuth profiles

ROTOXY keeps two ideas separate:

1. **API providers** receive inference requests through the gateway.
2. **Agent workers** are local CLIs that can perform delegated, tool-using work.

## Detection

```bash
rotoxy agents
```

Known CLI adapters include Codex CLI, Gemini CLI, Claude Code, GitHub Copilot CLI, AGY, and OpenCode.

ROTOXY may also detect desktop apps, but detection does not imply a safe headless automation API.

## Delegation

```bash
rotoxy delegate --worker codex --prompt "Review this codebase"
rotoxy delegate --pool subscriptions --prompt "Plan the migration"
rotoxy fanout --pool subscriptions --prompt "Independently audit this design"
```

ROTOXY uses conservative non-interactive modes where available. It does not automatically bypass provider permission or sandbox systems.

## OAuth/subscription accounts

ROTOXY never copies OAuth tokens out of an official CLI credential store.

### Codex

OpenAI documents `CODEX_HOME` as Codex's state root, including authentication and configuration. ROTOXY can therefore create separate state roots:

```bash
rotoxy oauth add codex personal
rotoxy oauth add codex work
```

### GitHub Copilot CLI

GitHub documents `COPILOT_HOME` as the CLI configuration-directory override:

```bash
rotoxy oauth add copilot personal
rotoxy oauth add copilot work
```

Copilot itself can also remember multiple accounts and switch users interactively.

### Gemini CLI

Gemini supports Google-account OAuth and headless use of cached credentials. Its public configuration documentation does not currently expose a general user-state-home override equivalent to `CODEX_HOME` or `COPILOT_HOME`, so ROTOXY treats the currently signed-in Gemini CLI as one worker unless a custom profile wrapper is supplied.

### Claude Code and AGY

These use their current official CLI session unless a stable isolated-profile mechanism is configured. ROTOXY does not scrape their credential stores.

## Desktop apps

ChatGPT Desktop, Claude Desktop, Antigravity IDE, Cursor and similar apps may be detected, but ROTOXY automates them only when they expose a documented CLI, gateway, or headless interface.

## Long-running orchestration

A main agent with shell access can call `rotoxy delegate` or `rotoxy fanout`. This lets ROTOXY act as a worker broker without requiring the main agent to understand each provider's login implementation.
