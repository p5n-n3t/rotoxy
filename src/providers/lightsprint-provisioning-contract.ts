import type { LightSprintProvisioningContract } from "./lightsprint-provisioning-adapter.js";

const MAX_DESCRIPTION_BYTES = 128 * 1024;
const MAX_PIN_VALUES = 512;
const ACCOUNT_ID = /^[A-Za-z0-9_-][A-Za-z0-9._:-]{0,127}$/;
const MODEL_VALUE = /^[^\u0000-\u001f\u007f,;=]{1,128}$/;
const EFFORT_VALUE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export type ProvisioningContractDiagnostic =
  | "catalog_invalid"
  | "catalog_oversized"
  | "task_create_evidence_missing"
  | "task_create_account_binding_unproven"
  | "task_create_workspace_scope_unproven"
  | "session_launch_evidence_missing"
  | "session_launch_account_binding_unproven"
  | "session_launch_workspace_scope_unproven"
  | "correlation_lookup_evidence_missing"
  | "correlation_lookup_identity_unproven"
  | "model_pin_semantics_unproven"
  | "effort_pin_semantics_unproven"
  | "model_pin_values_invalid"
  | "effort_pin_values_invalid";

export interface LightSprintProvisioningContractClassification {
  contract: LightSprintProvisioningContract;
  diagnostics: readonly ProvisioningContractDiagnostic[];
}

/**
 * Classifies only an explicit, machine-readable contract declaration in a provider
 * catalog description. Route names and descriptive prose are deliberately ignored.
 * The declaration format is documented by the parser itself and is not inferred from
 * observed endpoints.
 */
export function classifyLightSprintProvisioningContract(input: {
  accountId: string;
  description: unknown;
}): LightSprintProvisioningContractClassification {
  const diagnostics: ProvisioningContractDiagnostic[] = [];
  const unknownContract = (): LightSprintProvisioningContract => ({
    accountId: safeAccountId(input.accountId),
    status: "unknown",
    semantics: {
      accountPinned: false,
      workspaceScoped: false,
      taskCreate: false,
      sessionLaunch: false,
      correlationLookup: false,
    },
    modelPin: { status: "unknown" },
    effortPin: { status: "unknown" },
  });

  if (typeof input.description !== "string") {
    diagnostics.push("catalog_invalid");
    return { contract: unknownContract(), diagnostics };
  }
  if (Buffer.byteLength(input.description, "utf8") > MAX_DESCRIPTION_BYTES) {
    diagnostics.push("catalog_oversized");
    return { contract: unknownContract(), diagnostics };
  }
  if (!ACCOUNT_ID.test(input.accountId)) {
    diagnostics.push("catalog_invalid");
    return { contract: unknownContract(), diagnostics };
  }

  const declarations = new Map<string, string>();
  for (const rawLine of input.description.split(/\r?\n/)) {
    const line = rawLine.trim();
    const match = /^ROTOXY_PROVISIONING_V1\s+([A-Z_]+)\s*:\s*(.*?)\s*$/.exec(line);
    if (!match) continue;
    const [, key, value] = match;
    // Duplicate declarations are ambiguous and cannot increase trust.
    if (declarations.has(key)) declarations.set(key, "");
    else declarations.set(key, value);
  }

  const get = (key: string): string => declarations.get(key) ?? "";
  const truth = (key: string): boolean => get(key) === "true";
  const taskCreate = Boolean(get("TASK_CREATE_ROUTE")) && truth("TASK_CREATE_ACCOUNT_PINNED") && truth("TASK_CREATE_WORKSPACE_SCOPED");
  const sessionLaunch = Boolean(get("SESSION_LAUNCH_ROUTE")) && truth("SESSION_LAUNCH_ACCOUNT_PINNED") && truth("SESSION_LAUNCH_WORKSPACE_SCOPED");
  const correlationKeys = new Set(get("CORRELATION_LOOKUP_KEYS").split(",").map((part) => part.trim()).filter(Boolean));
  const correlationLookup = Boolean(get("CORRELATION_LOOKUP_ROUTE")) &&
    ["accountId", "workspaceId", "taskId", "idempotencyKey", "payloadDigest"].every((key) => correlationKeys.has(key));

  if (!get("TASK_CREATE_ROUTE")) diagnostics.push("task_create_evidence_missing");
  if (!truth("TASK_CREATE_ACCOUNT_PINNED")) diagnostics.push("task_create_account_binding_unproven");
  if (!truth("TASK_CREATE_WORKSPACE_SCOPED")) diagnostics.push("task_create_workspace_scope_unproven");
  if (!get("SESSION_LAUNCH_ROUTE")) diagnostics.push("session_launch_evidence_missing");
  if (!truth("SESSION_LAUNCH_ACCOUNT_PINNED")) diagnostics.push("session_launch_account_binding_unproven");
  if (!truth("SESSION_LAUNCH_WORKSPACE_SCOPED")) diagnostics.push("session_launch_workspace_scope_unproven");
  if (!get("CORRELATION_LOOKUP_ROUTE")) diagnostics.push("correlation_lookup_evidence_missing");
  if (get("CORRELATION_LOOKUP_ROUTE") && !correlationLookup) diagnostics.push("correlation_lookup_identity_unproven");

  const modelPin = parsePin(get("MODEL_PIN"), MODEL_VALUE);
  if (modelPin === null) diagnostics.push("model_pin_semantics_unproven");
  else if (modelPin.invalidValues) diagnostics.push("model_pin_values_invalid");

  const effortPin = parsePin(get("EFFORT_PIN"), EFFORT_VALUE);
  if (effortPin === null) diagnostics.push("effort_pin_semantics_unproven");
  else if (effortPin.invalidValues) diagnostics.push("effort_pin_values_invalid");

  const pinsValid = modelPin !== null && effortPin !== null && !modelPin.invalidValues && !effortPin.invalidValues;
  const complete = taskCreate && sessionLaunch && correlationLookup && pinsValid;
  const contract: LightSprintProvisioningContract = {
    accountId: input.accountId,
    status: complete ? "documented" : "unknown",
    semantics: {
      accountPinned: taskCreate && sessionLaunch,
      workspaceScoped: taskCreate && sessionLaunch,
      taskCreate,
      sessionLaunch,
      correlationLookup,
    },
    modelPin: modelPin && !modelPin.invalidValues ? modelPin.value : { status: "unknown" },
    effortPin: effortPin && !effortPin.invalidValues ? effortPin.value : { status: "unknown" },
  };
  return { contract, diagnostics };
}

function safeAccountId(value: string): string {
  return ACCOUNT_ID.test(value) ? value : "unknown-account";
}

function parsePin(
  declaration: string,
  validateValue: RegExp,
): { value: LightSprintProvisioningContract["modelPin"]; invalidValues: boolean } | null {
  const match = /^(supported|unsupported)\s*;\s*exact=(true|false)(?:\s*;\s*values=(.*))?$/.exec(declaration);
  if (!match || match[2] !== "true") return null;
  const status = match[1] as "supported" | "unsupported";
  const rawValues = match[3];
  if (status === "unsupported") {
    if (rawValues !== undefined && rawValues !== "") return { value: { status: "unsupported" }, invalidValues: true };
    return { value: { status: "unsupported" }, invalidValues: false };
  }
  if (rawValues === undefined || rawValues.length === 0) return { value: { status: "supported" }, invalidValues: true };
  const values = rawValues.split(",");
  const valid = values.length <= MAX_PIN_VALUES && values.length > 0 &&
    values.every((value) => value.length > 0 && value === value.trim() && validateValue.test(value)) &&
    new Set(values).size === values.length;
  return {
    value: valid ? { status: "supported", values } : { status: "supported" },
    invalidValues: !valid,
  };
}
