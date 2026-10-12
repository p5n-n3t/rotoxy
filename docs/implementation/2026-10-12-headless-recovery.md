# Headless Codex recovery adapter — 2026-10-12

## Assignment checkpoint

Base: `origin/main` at `e1d51cb24fd2ae00b3b111e40dd36462e4642f70`. Branch: `codex/rotoxy-recovery-headless-20261012`. The change is confined to `supervisor/snooze/headless.py`, `supervisor/snooze/recovery_service.py`, the two focused Python test files, and this checkpoint.

Follow-up hardening corrects Codex 0.162.1 flag placement, maps the remote recovery session to a separate explicit local Codex UUID, rejects mapping collisions and unsafe executable/project paths, and always reaps the subprocess leader after termination.

## Behavior and safety boundary

`RecoveryService` registers the `headless` callback only when a private opt-in block supplies an absolute executable, non-writable project directory, private `CODEX_HOME`, bounded timeout, and exact `(project, owner, remote session) -> codexSession UUID` mapping. It does not infer local CLI sessions from the remote model label or change the remote recovery binding. The fixed invocation is `[exe, --ask-for-approval, never, exec, --sandbox, read-only, resume, <allowlisted UUID>, --json, --ignore-user-config, -]`; the complete bounded instruction and JSON event metadata (including event id and job) arrive on stdin. It uses a minimal environment and captures at most 64 KiB. It kills the entire process group and reaps the leader on timeout, overflow, or exceptions. It never puts prompts, output, or credentials in receipts/logs. Once process creation succeeds, timeout, output overflow, malformed/missing completion, or nonzero exit is ambiguous; the engine's durable action receipt prevents replay after restart.

Headless remains blocked unless the existing `RecoveryEngine` resource verifier returns fresh, scope-matching evidence for both quota and available budget. The daemon now accepts that verifier only through trusted `RecoveryService(..., resource_verifier=...)` constructor injection; private config flags alone do not assert quota or credit. The current standalone CLI does not inject a verifier, so its headless configuration intentionally hands off until the integration root connects an authoritative evidence source. The tests use a fake executable and a mocked trusted verifier. No live provider invocation was made. Conversation wake, Codex approval interaction, and profile/quota discovery remain unsupported; the CLI resumes a session and gives a bounded advisory prompt only.

## Codex documentation checked

- https://developers.openai.com/codex/noninteractive/ — describes `codex exec resume <SESSION_ID>`, JSONL `--json`, and read-only default sandbox.
- https://developers.openai.com/codex/cli/reference/ — describes CLI sandbox and approval flags, including read-only and `never`.

The integration root verified this argument layout against Codex CLI 0.162.1 `exec resume --help`. This sandbox has no `codex` executable, so the change is verified with an exact-argv fake executable and was not run as a provider turn. No authenticated isolated home is configured here. No provider capability, approval endpoint, quota amount, or credit balance is inferred.
