# PF-HTTP checkpoint

Custom OpenAI-compatible provider requests now use a dedicated HTTPS transport. It resolves all DNS answers before sending the request, rejects the host if any answer is private/reserved/non-global, selects one public address, and pins the TLS connection to that address while preserving the saved hostname as TLS SNI and certificate name. It does not follow redirects. Requests are POST-only, limited to 1 MiB, responses to 2 MiB, and timeout/abort signals destroy the underlying request.

The adapter reads the bound account token and endpoint from one credential snapshot. Custom records with a missing token-origin binding are unusable; endpoint changes require token replacement. `tokenOrigin` is excluded from public account views. Fixed OpenAI/OpenRouter calls retain their existing fetch path.

No provider calls were made. Tests use injected DNS and HTTPS request seams. The DNS check rejects mixed public/private answer sets and pins the chosen address; DNS is re-resolved for each request. Source base: `641f51e87d0192b5919a7fe0e369a23fa961e55e`.
