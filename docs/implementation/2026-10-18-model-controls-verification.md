# Provider model controls verification — 2026-10-18

Scope: client-token endpoint reference; explicit OpenAI-compatible catalog discovery and saved model allowlists; Cloudflare paginated catalog/search/selection; Bedrock Runtime/Mantle catalog and persisted selection.

- ORA5 isolated Node 22 container: TypeScript build passed; 479 Node tests passed, zero failures. Test execution used `--network=none`, three test processes, no production mounts or credentials.
- `npm audit`: zero vulnerabilities.
- `git diff --check`: passed.
- Impeccable detector on the four changed admin surfaces: no findings.
- Built-in ChatGPT browser reached an isolated loopback preview with synthetic credentials and catalogs. Endpoint references and populated Bedrock/OpenRouter controls rendered. Browser submission exposed an Origin-null failure caused by `Referrer-Policy: no-referrer`; changed the affected model-management surfaces to `same-origin`, retaining Origin/CSRF validation. Bedrock regression rejects null and foreign origins.

No paid inference, account-enablement agreement, IAM change, credit purchase, billing change, or real provider refresh was performed. AWS catalog visibility, account entitlement, and promotional-credit eligibility remain separate and are not inferred from these tests. Runtime installation/deployment is separate from this source verification.

Remote evidence: `/tmp/rotoxy-direct-provider-apSSEScE/build-catalog-browser.log` and `node-tests-catalog-browser.log` on ORA5. These temporary logs are not a permanent release artifact; the acceptance counts and limitations are recorded here.

Browser round-trips passed after the policy fix: Bedrock saved two selected IDs; OpenRouter saved two manually entered model IDs; Cloudflare cleared the old selection and saved exactly one different model. All used isolated synthetic accounts. Live provider entitlement and inference remain unverified by this milestone.

Fresh package installation smoke passed on ORA5: 553 packaged files, both CLI entrypoints, bundled UI/licenses, private fresh state, Python bridge help, manual startup plan, loopback health, and clean owned-child shutdown.
