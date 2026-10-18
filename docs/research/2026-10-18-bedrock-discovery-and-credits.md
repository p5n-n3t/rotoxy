# Bedrock discovery and credit evidence

Verified documentation date: 2026-10-18. No account billing, credit grant, subscription, IAM permission or model agreement was changed. No inference was used to test access.

## Discovery is not entitlement

The three model defaults in a Claude Code configuration are client selections, not a complete AWS account catalog. Bedrock Runtime discovery uses `ListFoundationModels` and `ListInferenceProfiles`. A base model ID may require an inference profile for invocation. Bedrock Mantle has a separate model-list endpoint. Catalog presence alone does not establish successful execution, an available inference quota, or whether a credit grant covers that usage.

ROTOXY therefore records the provider catalog separately from the operator-enabled allowlist. Discovery is an explicit metadata action and does not subscribe to or invoke models. Enabled selections filter the catalog exposed to clients and are enforced before inference. The stored catalog labels entitlement as unknown.

## Credits and endpoint choice

The official sources reviewed do not establish a blanket rule that an account using its $200 signup credits cannot use Bedrock Mantle or can use only three older Claude models. AWS distinguishes the Free/Paid account plan, service/model permissions, regional endpoint support, quotas, and credit eligibility. The Free Tier FAQ says remaining credits can continue to apply after upgrading to a Paid plan. That is not a guarantee that every model charge is eligible.

The general promotional credit terms cover only designated eligible services and exclude Marketplace charges unless AWS authorizes an exception. Some programs have specific exceptions; for example, AWS Activate terms discuss third-party Bedrock model spend. That must not be generalized to a different signup credit grant. ROTOXY does not infer credit coverage from an endpoint name, a successful login, a model listing, or an enabled checkbox.

No account-specific conclusion about this operator's Mantle access or credit eligibility has been verified by this documentation review. Read-only model availability information can narrow access questions; the applicable credit grant remains the source for credit coverage.

## Official sources

- [Bedrock model discovery](https://docs.aws.amazon.com/bedrock/latest/userguide/models-get-info.html)
- [Bedrock model access and permissions](https://docs.aws.amazon.com/bedrock/latest/userguide/model-access.html)
- [AWS Free Tier FAQ](https://aws.amazon.com/free/free-tier-faqs/)
- [AWS promotional credit terms](https://aws.amazon.com/awscredits/)
- [AWS Activate terms](https://aws.amazon.com/activate/terms/)
