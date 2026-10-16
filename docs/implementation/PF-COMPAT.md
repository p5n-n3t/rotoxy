# PF-COMPAT checkpoint

Implemented admin-defined HTTPS OpenAI-compatible provider origins in the encrypted inference account store and routed their allowlisted model IDs through `/v1/models` and `/v1/chat/completions`. Custom IDs are random `custom-…` namespaces; bearer values remain encrypted and are never rendered. An endpoint edit invalidates existing token-origin bindings; replacing the account token binds it to the saved origin. Fixed OpenAI/OpenRouter presets retain their current IDs and origins.

URL validation accepts HTTPS origin-only URLs and rejects credentials, path, query, fragment, local names, IP literals (including private/link-local), and nonstandard ports. Requests remain server-selected, bounded, redirect errors, and single-attempt. No provider/network calls were made.

Checkpoint base: `d2e354c3dd11002286b824c3a6733e859815ee29`. Remaining verification: run TypeScript build and focused tests; DNS answers for public hostnames are not resolved or pinned, so endpoint policy is hostname-based and does not defend against DNS rebinding to private addresses.
