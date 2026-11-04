export const JOB_TOOLS = ["job_submit", "job_status", "job_wait", "job_workers", "job_results", "job_control", "job_inbox", "job_inbox_ack"] as const;
export type JobToolName = typeof JOB_TOOLS[number];
export type JobScope = "jobs:read" | "jobs:write";

export interface JobSubmission {
  schemaVersion: 1;
  jobId: string;
  idempotencyKey: string;
  projectId: string;
  eligibleAccountIds: string[];
  scheduling?: { profile: "economy" | "balanced" | "throughput" | "custom"; maxConcurrency?: number };
  tasks: JobTaskInput[];
}

export interface JobTaskInput {
  taskId: string;
  dependsOn: string[];
  scopeKeys: string[];
  inputRef?: string;
  inputSha256?: string;
  instructions: string;
  execution: { mode: "fresh"; provider: "claude" | "codex" | "auto" | "pi" } | { mode: "existing-session" } |
    { mode: "inference"; provider: "oracle" | "cloudflare"; model: string; maxOutputTokens: number } |
    { mode: "agent"; provider: "claude-code"; profileId: string; model: string; timeoutMs: number };
  output: { kind: "text"; maxBytes: number; format: string; expectedMarker: string };
  priority?: number;
  observationTimeoutSeconds?: number;
}

export class JobInputError extends Error {
  constructor(message: string) { super(message); this.name = "JobInputError"; }
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const HASH = /^[a-f0-9]{64}$/;
const object = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const id = (v: unknown, label: string): string => {
  if (typeof v !== "string" || !ID.test(v)) throw new JobInputError(`${label} must be a safe identifier`);
  return v;
};
const str = (v: unknown, label: string, max: number): string => {
  if (typeof v !== "string" || !v.trim() || v.length > max) throw new JobInputError(`${label} must be non-empty and at most ${max} characters`);
  return v;
};
const only = (v: Record<string, unknown>, keys: string[], label: string) => {
  if (Object.keys(v).some((key) => !keys.includes(key))) throw new JobInputError(`${label} contains an unsupported field`);
};

function scopeKey(value: unknown): string {
  if (typeof value !== "string" || value.length > 512) throw new JobInputError("scopeKeys contain an invalid scope");
  if (value.startsWith("record:") && /^record:[^\s:][^\s]*$/.test(value)) return value;
  if (value.startsWith("path:")) {
    const path = value.slice(5);
    if (!path || path.startsWith("/") || path.includes("\\") || path.split("/").some((part) => !part || part === "." || part === "..")) {
      throw new JobInputError("path scopes must be safe repository-relative paths");
    }
    return value;
  }
  throw new JobInputError("scopeKeys must use record: or path: scopes");
}

function parseTask(raw: unknown): JobTaskInput {
  if (!object(raw)) throw new JobInputError("each task must be an object");
  only(raw, ["taskId", "dependsOn", "scopeKeys", "inputRef", "inputSha256", "instructions", "execution", "output", "priority", "observationTimeoutSeconds"], "task");
  const taskId = id(raw.taskId, "taskId");
  let observationTimeoutSeconds: number | undefined;
  if (raw.observationTimeoutSeconds !== undefined) {
    if (!Number.isInteger(raw.observationTimeoutSeconds) || Number(raw.observationTimeoutSeconds) < 60 || Number(raw.observationTimeoutSeconds) > 604800)
      throw new JobInputError("observationTimeoutSeconds must be an integer from 60 to 604800");
    observationTimeoutSeconds = Number(raw.observationTimeoutSeconds);
  }
  let priority: number | undefined;
  if (raw.priority !== undefined) {
    if (!Number.isInteger(raw.priority) || Number(raw.priority) < -100 || Number(raw.priority) > 100) throw new JobInputError("priority must be an integer from -100 to 100");
    priority = Number(raw.priority);
  }
  if (!Array.isArray(raw.dependsOn) || raw.dependsOn.length > 8) throw new JobInputError("dependsOn must be an array of at most 8 task IDs");
  const dependsOn = raw.dependsOn.map((v) => id(v, "dependency"));
  if (new Set(dependsOn).size !== dependsOn.length || dependsOn.includes(taskId)) throw new JobInputError("dependencies must be unique and cannot include the task itself");
  if (!Array.isArray(raw.scopeKeys) || !raw.scopeKeys.length || raw.scopeKeys.length > 32) throw new JobInputError("scopeKeys must contain 1–32 scopes");
  const scopeKeys = raw.scopeKeys.map(scopeKey);
  if (new Set(scopeKeys).size !== scopeKeys.length) throw new JobInputError("scopeKeys must be unique");
  let inputRef: string | undefined;
  let inputSha256: string | undefined;
  if (raw.inputRef !== undefined) {
    inputRef = str(raw.inputRef, "inputRef", 2048);
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(inputRef)) throw new JobInputError("inputRef must be an opaque local reference, not a URL");
  }
  if (raw.inputSha256 !== undefined) {
    if (typeof raw.inputSha256 !== "string" || !HASH.test(raw.inputSha256) || !inputRef) throw new JobInputError("inputSha256 requires inputRef and 64 lowercase hexadecimal characters");
    inputSha256 = raw.inputSha256;
  }
  if (typeof raw.instructions !== "string" || !raw.instructions.trim() || Buffer.byteLength(raw.instructions, "utf8") > 16_384) throw new JobInputError("instructions must be non-empty and at most 16384 bytes");
  const instructions = raw.instructions;
  if (!object(raw.execution)) throw new JobInputError("execution must be an object");
  let execution: JobTaskInput["execution"];
  if (raw.execution.mode === "fresh") {
    only(raw.execution, ["mode", "provider"], "execution");
    if (typeof raw.execution.provider !== "string" || !["claude", "codex", "auto", "pi"].includes(raw.execution.provider)) {
      throw new JobInputError("fresh execution requires provider claude, codex, auto, or pi");
    }
    execution = { mode: "fresh", provider: raw.execution.provider as Extract<JobTaskInput["execution"], { mode: "fresh" }>["provider"] };
  } else if (raw.execution.mode === "existing-session") {
    only(raw.execution, ["mode"], "execution");
    execution = { mode: "existing-session" };
  } else if (raw.execution.mode === "inference") {
    only(raw.execution, ["mode", "provider", "model", "maxOutputTokens"], "execution");
    if (raw.execution.provider !== "oracle" && raw.execution.provider !== "cloudflare") throw new JobInputError("inference provider must be oracle or cloudflare");
    const model = str(raw.execution.model, "inference model", 160);
    const validModel = raw.execution.provider === "oracle" ? /^oracle\/[A-Za-z0-9._:-]{1,160}$/.test(model) : /^@?[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+$/.test(model);
    if (!validModel) throw new JobInputError("inference model does not match its provider");
    if (!Number.isSafeInteger(raw.execution.maxOutputTokens) || Number(raw.execution.maxOutputTokens) < 1 || Number(raw.execution.maxOutputTokens) > 4096) throw new JobInputError("maxOutputTokens must be between 1 and 4096");
    execution = { mode: "inference", provider: raw.execution.provider, model, maxOutputTokens: Number(raw.execution.maxOutputTokens) };
  } else if (raw.execution.mode === "agent") {
    only(raw.execution, ["mode", "provider", "profileId", "model", "timeoutMs"], "execution");
    if (raw.execution.provider !== "claude-code") throw new JobInputError("agent provider must be claude-code");
    const profileId = id(raw.execution.profileId, "agent profileId");
    const model = str(raw.execution.model, "agent model", 160);
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(model)) throw new JobInputError("invalid agent model");
    if (!Number.isSafeInteger(raw.execution.timeoutMs) || Number(raw.execution.timeoutMs) < 100 || Number(raw.execution.timeoutMs) > 120000) throw new JobInputError("agent timeoutMs must be between 100 and 120000");
    execution = { mode: "agent", provider: "claude-code", profileId, model, timeoutMs: Number(raw.execution.timeoutMs) };
  } else throw new JobInputError("execution.mode must be fresh, existing-session, inference, or agent");

  if (!object(raw.output) || raw.output.kind !== "text") throw new JobInputError("the current supervisor supports bounded text output only");
  only(raw.output, ["kind", "maxBytes", "format", "expectedMarker"], "output");
  if (!Number.isInteger(raw.output.maxBytes) || Number(raw.output.maxBytes) < 1 || Number(raw.output.maxBytes) > 32_768) throw new JobInputError("text maxBytes must be between 1 and 32768");
  const expectedMarker = str(raw.output.expectedMarker, "expectedMarker", 256);
  if (/[\r\n\0]/.test(expectedMarker) || expectedMarker !== expectedMarker.trim()) throw new JobInputError("expectedMarker must be a single exact, trimmed line of at most 256 characters");
  const output: JobTaskInput["output"] = { kind: "text", maxBytes: Number(raw.output.maxBytes), format: str(raw.output.format, "text format", 64), expectedMarker };
  return { taskId, dependsOn, scopeKeys, inputRef, inputSha256, instructions, execution, output, priority, ...(observationTimeoutSeconds === undefined ? {} : {observationTimeoutSeconds}) };
}

export function validateJobSubmission(value: unknown): JobSubmission {
  if (!object(value)) throw new JobInputError("job submission must be an object");
  only(value, ["schemaVersion", "jobId", "idempotencyKey", "projectId", "eligibleAccountIds", "scheduling", "tasks"], "job submission");
  if (value.schemaVersion !== 1) throw new JobInputError("schemaVersion must be 1");
  if (JSON.stringify(value).length > 1_048_576) throw new JobInputError("job submission exceeds 1 MiB");
  if (!Array.isArray(value.eligibleAccountIds) || value.eligibleAccountIds.length < 1 || value.eligibleAccountIds.length > 50) throw new JobInputError("eligibleAccountIds must contain 1–50 configured account IDs");
  const eligibleAccountIds = value.eligibleAccountIds.map((v) => id(v, "eligible account ID"));
  if (new Set(eligibleAccountIds).size !== eligibleAccountIds.length) throw new JobInputError("eligibleAccountIds must be unique");
  let scheduling: JobSubmission["scheduling"];
  if (value.scheduling !== undefined) {
    if (!object(value.scheduling)) throw new JobInputError("scheduling must be an object");
    only(value.scheduling, ["profile", "maxConcurrency"], "scheduling");
    const profile = value.scheduling.profile;
    if (typeof profile !== "string" || !["economy", "balanced", "throughput", "custom"].includes(profile)) throw new JobInputError("unsupported scheduling profile");
    const normalizedProfile = profile as NonNullable<JobSubmission["scheduling"]>["profile"];
    if (normalizedProfile === "custom") {
      if (!Number.isInteger(value.scheduling.maxConcurrency) || Number(value.scheduling.maxConcurrency) < 1 || Number(value.scheduling.maxConcurrency) > 32) throw new JobInputError("custom scheduling requires maxConcurrency from 1 to 32");
      scheduling = { profile: normalizedProfile, maxConcurrency: Number(value.scheduling.maxConcurrency) };
    } else {
      if (value.scheduling.maxConcurrency !== undefined) throw new JobInputError("maxConcurrency is only valid for the custom profile");
      scheduling = { profile: normalizedProfile };
    }
  }
  if (!Array.isArray(value.tasks) || value.tasks.length < 1 || value.tasks.length > 100) throw new JobInputError("tasks must contain 1–100 DAG nodes");
  const tasks = value.tasks.map(parseTask);
  const taskIds = new Set(tasks.map((task) => task.taskId));
  if (taskIds.size !== tasks.length) throw new JobInputError("taskIds must be unique");
  for (const task of tasks) if (task.dependsOn.some((dependency) => !taskIds.has(dependency))) throw new JobInputError("all dependencies must refer to tasks in this job");
  const visiting = new Set<string>(); const visited = new Set<string>();
  const byId = new Map(tasks.map((task) => [task.taskId, task]));
  const visit = (taskId: string): void => {
    if (visiting.has(taskId)) throw new JobInputError("tasks must form an acyclic DAG");
    if (visited.has(taskId)) return;
    visiting.add(taskId);
    for (const dependency of byId.get(taskId)!.dependsOn) visit(dependency);
    visiting.delete(taskId); visited.add(taskId);
  };
  for (const task of tasks) visit(task.taskId);
  return {
    schemaVersion: 1,
    jobId: id(value.jobId, "jobId"),
    idempotencyKey: id(value.idempotencyKey, "idempotencyKey"),
    projectId: id(value.projectId, "projectId"),
    eligibleAccountIds,
    scheduling,
    tasks,
  };
}

const string = { type: "string" };
const tool = (name: JobToolName, description: string, properties: Record<string, unknown>, required: string[], additionalProperties = false) => ({
  name, description, inputSchema: { type: "object", properties, required, additionalProperties },
});
const jobKey = { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$" };
export const JOB_TOOL_DEFINITIONS = [
  tool("job_submit", "Submit one explicitly authorized bounded DAG for durable account-pinned execution. Inference tasks must select provider oracle or cloudflare, an exact allowlisted model, maxOutputTokens from 1 to 4096, and a text output marker. Oracle output requires provider-reported finish evidence; Cloudflare output must end with the exact expectedMarker as its final nonempty line. Oracle uses the small-model allowlist; Cloudflare model allowlists and account health are checked at dispatch.", {
    schemaVersion: { type: "integer", const: 1 }, jobId: jobKey, idempotencyKey: jobKey, projectId: jobKey,
    scheduling: { type: "object", additionalProperties: false, required: ["profile"], properties: {
      profile: { type: "string", enum: ["economy", "balanced", "throughput", "custom"] },
      maxConcurrency: { type: "integer", minimum: 1, maximum: 32, description: "Only valid with profile=custom. Omit this field for economy, balanced, or throughput." },
    } },
    eligibleAccountIds: { type: "array", minItems: 1, maxItems: 50, uniqueItems: true, items: jobKey },
    tasks: { type: "array", minItems: 1, maxItems: 100, items: { type: "object", additionalProperties: false,
      required: ["taskId", "dependsOn", "scopeKeys", "instructions", "execution", "output"],
      properties: {
        taskId: jobKey, dependsOn: { type: "array", maxItems: 8, items: jobKey }, priority: { type: "integer", minimum: -100, maximum: 100 }, scopeKeys: { type: "array", minItems: 1, maxItems: 32, uniqueItems: true, items: { type: "string", maxLength: 512 } },
        inputRef: { type: "string", minLength: 1, maxLength: 2048 }, inputSha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
        observationTimeoutSeconds: { type: "integer", minimum: 60, maximum: 604800, description: "Monitoring deadline only; expiry requires reconciliation and does not cancel the upstream worker. Default six hours." },
        instructions: { type: "string", minLength: 1, maxLength: 16384 },
        execution: { oneOf: [
          { type: "object", additionalProperties: false, required: ["mode", "provider", "profileId", "model", "timeoutMs"], properties: {
            mode: { const: "agent" }, provider: { const: "claude-code" }, profileId: jobKey,
            model: { type: "string", minLength: 1, maxLength: 160 }, timeoutMs: { type: "integer", minimum: 100, maximum: 120000 },
          } },
          { type: "object", additionalProperties: false, required: ["mode"], properties: { mode: { const: "existing-session" } } },
          { type: "object", additionalProperties: false, required: ["mode", "provider"], properties: {
            mode: { const: "fresh" }, provider: { type: "string", enum: ["claude", "codex", "auto", "pi"] },
          } },
          { type: "object", additionalProperties: false, required: ["mode", "provider", "model", "maxOutputTokens"], properties: {
            mode: { const: "inference" }, provider: { type: "string", enum: ["oracle", "cloudflare"] },
            model: { type: "string", minLength: 1, maxLength: 160, description: "Exact provider model ID; Oracle models are prefixed oracle/, Cloudflare IDs use @cf/…" },
            maxOutputTokens: { type: "integer", minimum: 1, maximum: 4096, description: "Hard output token limit checked against the registered provider cap." },
          } },
        ] },
        output: { type: "object", additionalProperties: false, required: ["kind", "maxBytes", "format", "expectedMarker"], properties: {
          kind: { const: "text" }, maxBytes: { type: "integer", minimum: 1, maximum: 32768 },
          format: { type: "string", minLength: 1, maxLength: 64 }, expectedMarker: { type: "string", minLength: 1, maxLength: 256, pattern: "^[^\\r\\n]+$" },
        } },
      } } },
  }, ["schemaVersion", "jobId", "idempotencyKey", "projectId", "eligibleAccountIds", "tasks"]),
  tool("job_status", "Read one job's state for an authorized project.", { projectId: jobKey, jobId: jobKey }, ["projectId", "jobId"]),
  tool("job_wait", "Wait briefly for an authorized job's durable status to change. Uses status reads only; it does not wake or resume workers.", {
    projectId: jobKey, jobId: jobKey,
    timeoutSeconds: { type: "integer", minimum: 1, maximum: 20, default: 15 },
    snapshot: { type: "string", pattern: "^[a-f0-9]{64}$", description: "Opaque status fingerprint from a previous job_wait response; never an authorization token." },
  }, ["projectId", "jobId"]),
  tool("job_workers", "Read bounded worker/account observations for an authorized project.", { projectId: jobKey }, ["projectId"]),
  tool("job_results", "Read bounded results for an authorized job/task.", { projectId: jobKey, jobId: jobKey, taskId: jobKey }, ["projectId", "jobId"]),
  tool("job_control", "Apply an allowlisted durable pause, stop, resume, cancellation, or revision-fenced reconciliation. Reconcile observes an existing session or performs one read-only task-scoped session lookup after an ambiguous fresh launch; it never relaunches work.", { projectId: jobKey, action: { type: "string", enum: ["pause_dispatch", "resume_dispatch", "emergency_stop", "cancel_job", "reconcile_task"] }, jobId: jobKey, taskId: jobKey, expectedRevision: { type: "integer", minimum: 1 } }, ["projectId", "action"]),
  tool("job_inbox", "Read the caller's bounded durable incident inbox.", { projectId: jobKey, after: { type: "string", maxLength: 128 }, limit: { type: "integer", minimum: 1, maximum: 100 } }, ["projectId"]),
  tool("job_inbox_ack", "Acknowledge one event in the caller's durable project inbox.", {
    projectId: jobKey, eventId: { type: "string", pattern: "^(?:repo|job):[1-9][0-9]{0,18}$", maxLength: 24 },
  }, ["projectId", "eventId"]),
] as const;

export function isJobToolName(value: unknown): value is JobToolName {
  return typeof value === "string" && (JOB_TOOLS as readonly string[]).includes(value);
}

export function requiredJobScope(name: JobToolName): JobScope {
  return name === "job_submit" || name === "job_control" || name === "job_inbox_ack" ? "jobs:write" : "jobs:read";
}

export function validateJobToolArguments(name: JobToolName, value: unknown): unknown {
  if (name === "job_submit") return validateJobSubmission(value);
  if (!object(value)) throw new JobInputError("tool arguments must be an object");
  const allowed: Record<Exclude<JobToolName, "job_submit">, string[]> = {
    job_status: ["projectId", "jobId"], job_wait: ["projectId", "jobId", "timeoutSeconds", "snapshot"], job_workers: ["projectId"], job_results: ["projectId", "jobId", "taskId"],
    job_control: ["projectId", "action", "jobId", "taskId", "expectedRevision"], job_inbox: ["projectId", "after", "limit"],
    job_inbox_ack: ["projectId", "eventId"],
  };
  only(value, allowed[name], name);
  id(value.projectId, "projectId");
  if (name === "job_status" || name === "job_wait" || name === "job_results") id(value.jobId, "jobId");
  if (name === "job_wait") {
    if (value.timeoutSeconds !== undefined && (!Number.isInteger(value.timeoutSeconds) || Number(value.timeoutSeconds) < 1 || Number(value.timeoutSeconds) > 20)) {
      throw new JobInputError("timeoutSeconds must be an integer from 1 to 20");
    }
    if (value.snapshot !== undefined && (typeof value.snapshot !== "string" || !/^[a-f0-9]{64}$/.test(value.snapshot))) {
      throw new JobInputError("snapshot must be an opaque status fingerprint");
    }
  }
  if (name === "job_results" && value.taskId !== undefined) id(value.taskId, "taskId");
  if (name === "job_control") {
    if (!["pause_dispatch", "resume_dispatch", "emergency_stop", "cancel_job", "reconcile_task"].includes(String(value.action))) throw new JobInputError("unsupported control action");
    if (value.action === "cancel_job") id(value.jobId, "jobId");
    if (value.action === "reconcile_task") {
      id(value.jobId, "jobId");
      id(value.taskId, "taskId");
      if (typeof value.expectedRevision !== "number" || !Number.isSafeInteger(value.expectedRevision) || Number(value.expectedRevision) < 1) throw new JobInputError("expectedRevision must be a positive safe integer");
    } else if (value.taskId !== undefined || value.expectedRevision !== undefined) {
      throw new JobInputError("taskId and expectedRevision require reconcile_task");
    }
  }
  if (name === "job_inbox") {
    if (value.after !== undefined && (typeof value.after !== "string" || value.after.length > 128 || /[\u0000-\u001f\u007f]/.test(value.after))) throw new JobInputError("after must be a bounded opaque cursor string");
    if (value.limit !== undefined && (!Number.isInteger(value.limit) || Number(value.limit) < 1 || Number(value.limit) > 100)) throw new JobInputError("limit must be between 1 and 100");
  }
  if (name === "job_inbox_ack" && (typeof value.eventId !== "string" || !/^(?:repo|job):[1-9][0-9]{0,18}$/.test(value.eventId))) {
    throw new JobInputError("eventId must be a safe durable inbox event ID");
  }
  return value;
}
