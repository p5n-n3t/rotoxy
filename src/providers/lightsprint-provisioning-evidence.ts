import type { LightSprintProvisioningContractClassification, ProvisioningContractDiagnostic } from "./lightsprint-provisioning-contract.js";

export type ProvisioningEvidenceStatus = "available" | "unavailable" | "unknown";

export type ProvisioningEvidenceReason =
  | ProvisioningContractDiagnostic
  | "contract_unavailable"
  | "evidence_malformed";

export interface LightSprintProvisioningEvidence {
  status: ProvisioningEvidenceStatus;
  reasons: readonly ProvisioningEvidenceReason[];
  capabilities: {
    accountPinned: boolean;
    workspaceScoped: boolean;
    taskCreate: boolean;
    sessionLaunch: boolean;
    correlationLookup: boolean;
    modelPin: boolean;
    effortPin: boolean;
  };
}

const DIAGNOSTICS = new Set<ProvisioningContractDiagnostic>([
  "catalog_invalid",
  "catalog_oversized",
  "task_create_evidence_missing",
  "task_create_account_binding_unproven",
  "task_create_workspace_scope_unproven",
  "session_launch_evidence_missing",
  "session_launch_account_binding_unproven",
  "session_launch_workspace_scope_unproven",
  "correlation_lookup_evidence_missing",
  "correlation_lookup_identity_unproven",
  "model_pin_semantics_unproven",
  "effort_pin_semantics_unproven",
  "model_pin_values_invalid",
  "effort_pin_values_invalid",
]);
const MAX_REASONS = 32;

const emptyCapabilities = () => ({
  accountPinned: false,
  workspaceScoped: false,
  taskCreate: false,
  sessionLaunch: false,
  correlationLookup: false,
  modelPin: false,
  effortPin: false,
});

/**
 * Projects classifier evidence into bounded, non-identifying dashboard data.
 * This describes documented capability only; it does not launch or verify a job.
 */
export function projectLightSprintProvisioningEvidence(input: unknown): LightSprintProvisioningEvidence {
  try {
    if (!isPlainRecord(input)) return malformedEvidence();
    const contract = ownData(input, "contract");
    const diagnostics = ownData(input, "diagnostics");
    if (!isPlainRecord(contract) || !Array.isArray(diagnostics)) return malformedEvidence();

    const statusValue = ownData(contract, "status");
    const semantics = ownData(contract, "semantics");
    const modelPin = ownData(contract, "modelPin");
    const effortPin = ownData(contract, "effortPin");
    if ((statusValue !== "documented" && statusValue !== "unknown" && statusValue !== "unavailable") ||
        !isPlainRecord(semantics) || !isPlainRecord(modelPin) || !isPlainRecord(effortPin)) {
      return malformedEvidence();
    }

    const modelValues = ownData(modelPin, "values");
    const effortValues = ownData(effortPin, "values");
    const capabilities = {
      accountPinned: ownData(semantics, "accountPinned") === true,
      workspaceScoped: ownData(semantics, "workspaceScoped") === true,
      taskCreate: ownData(semantics, "taskCreate") === true,
      sessionLaunch: ownData(semantics, "sessionLaunch") === true,
      correlationLookup: ownData(semantics, "correlationLookup") === true,
      modelPin: ownData(modelPin, "status") === "supported" && Array.isArray(modelValues) && modelValues.length > 0,
      effortPin: ownData(effortPin, "status") === "supported" && Array.isArray(effortValues) && effortValues.length > 0,
    };

    const coreComplete = capabilities.accountPinned && capabilities.workspaceScoped && capabilities.taskCreate &&
      capabilities.sessionLaunch && capabilities.correlationLookup;
    const status: ProvisioningEvidenceStatus = statusValue === "unavailable"
      ? "unavailable"
      : statusValue === "documented" && coreComplete ? "available" : "unknown";

    const reasons: ProvisioningEvidenceReason[] = [];
    for (const reason of diagnostics.slice(0, MAX_REASONS)) {
      if (typeof reason === "string" && DIAGNOSTICS.has(reason as ProvisioningContractDiagnostic) && !reasons.includes(reason as ProvisioningContractDiagnostic)) {
        reasons.push(reason as ProvisioningContractDiagnostic);
      }
    }
    if (status === "unavailable" && reasons.length === 0) reasons.push("contract_unavailable");
    if (status === "unknown" && reasons.length === 0) reasons.push("evidence_malformed");

    // Retain only fixed enums and booleans. Never forward account, route, catalog, or pin values.
    return { status, reasons, capabilities };
  } catch {
    return malformedEvidence();
  }
}

function malformedEvidence(): LightSprintProvisioningEvidence {
  return { status: "unknown", reasons: ["evidence_malformed"], capabilities: emptyCapabilities() };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function ownData(record: Record<string, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

// Keep the public type useful to callers without requiring them to import provider internals.
export type LightSprintProvisioningClassification = LightSprintProvisioningContractClassification;
