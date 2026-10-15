# Profile and Ollama credential edits

Base `origin/main`: `15767e1c31410bc9125f543c53d372fe8e865efb`. Branch: `codex/rotoxy-profile-edit-20261015`.

`CodexProfiles` now exposes `updateProfile(id, { label })` and `renameProfile(id, label)`. Edits preserve profile ID, private `CODEX_HOME`, timestamps other than `updatedAt`, and saved thread ownership. Profile registry reads and writes during mutation share the gateway's cross-process `state.lock`; writes remain atomic. Labels are bounded/printable and rename rejects collisions.

`ModelCredentialStore` now exposes `updateCredential(id, { label?, enabled? })` and `renameCredential(id, label)`. These use the existing `StateStore.update` lock and atomic persistence path. API key rotation remains separate; returned views omit secrets. Duplicate labels and unsupported fields are rejected for updates. Existing admin routes were inspected but left unchanged so the root can wire these public methods.

The new isolated test sets temporary `HOME` and `TOKEN2OAUTH_CONFIG_DIR` before constructing stores, edits records from separate Node processes, and checks auth-file preservation, thread ownership, unrelated records, encrypted credentials, and redacted views.

Validation: `npm test` passed (340 tests); the focused command `node --test test/profile-edit.test.mjs test/codex-profiles.test.mjs test/model-gateway.test.mjs` passed 8/8. The profile-edit regression passed again after final label-validation assertions. No real user profile or provider credential was read or changed.
