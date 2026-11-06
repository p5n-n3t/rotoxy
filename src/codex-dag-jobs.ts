import { createHash } from "node:crypto";
import type { StateStore } from "./store.js";
import type { PersistedState } from "./types.js";
import type { AgentWorkspaceService } from "./agent-workspace.js";
import type { CodexProfiles, CodexProfileSnapshot, CodexExecutionHandle } from "./codex-profiles.js";
import { CodexPoolPolicyStore, codexProfileFitsTask } from "./codex-pool-policy.js";
import { OriginProtectionStore } from "./origin-protection.js";
import type { AgentJobExecutor, AgentResource, JobOperation, JobResult } from "./job-worker.js";

interface Attempt {
  operationId: string;
  projectId: string;
  clientId: string;
  jobId: string;
  taskId: string;
  profileId: string;
  model: string;
  reasoningEffort: string;
  digest: string;
  status: "intent" | "running" | "success" | "ambiguous";
  requestStartedAt: number;
  threadId?: string;
  turnId?: string;
  result?: Record<string, unknown>;
  pendingApprovals?: Array<{ requestId: string; method: string; observedAt: number }>;
}
type AttemptState = PersistedState & { codexDagAttempts?: Record<string, Attempt> };
type Profiles = Pick<CodexProfiles, "listProfiles" | "refreshProfile" | "startExecution">;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/** Uses the existing StateStore transaction as a launch fence and the workspace
 * ledger for artifacts. An existing intent is reconciled, never launched again. */
export class CodexDagJobs implements AgentJobExecutor {
  readonly provider = "codex" as const;
  private readonly unavailableUntil = new Map<string, number>();
  private readonly policy: CodexPoolPolicyStore;
  private readonly origins: OriginProtectionStore;
  private readonly snapshots = new Map<string, CodexProfileSnapshot>();
  private readonly active = new Map<string, { attempt: Attempt; handle?: CodexExecutionHandle; cancelled: boolean }>();
  private readonly cancelledJobs = new Set<string>();
  private closed = false;

  constructor(private readonly store: StateStore, private readonly profiles: Profiles,
    private readonly workspace: Pick<AgentWorkspaceService, "snapshot" | "update">,
    private readonly cwd: string) {
    this.policy = new CodexPoolPolicyStore(store);
    this.origins = new OriginProtectionStore(store);
  }

  async resources(): Promise<AgentResource[]> {
    const policy = await this.policy.read();
    if (!policy.dispatchEnabled || this.closed) return [];
    const result: AgentResource[] = [];
    const registry = await this.profiles.listProfiles();
    await Promise.all(policy.profiles.filter(row => row.enabled).map(async rule => {
      if ((this.unavailableUntil.get(rule.profileId) ?? 0) > Date.now()) return;
      try {
        let snapshot = this.snapshots.get(rule.profileId);
        if (!snapshot || Date.now() - snapshot.capturedAt > 60_000) {
          snapshot = await this.profiles.refreshProfile(rule.profileId);
          this.snapshots.set(rule.profileId, snapshot);
        }
        const models = snapshot.models.filter(model => model.reasoningEfforts?.some(reasoningEffort =>
          codexProfileFitsTask(snapshot!, { modelId: model.id, complexity: "routine", reasoningEffort })));
        if (!snapshot.accountIdentity || !models.length) return;
        result.push({ accountId: "codex:" + rule.profileId, provider: "codex", profileId: rule.profileId,
          label: registry.find(profile => profile.id === rule.profileId)?.label, planType: snapshot.planType,
          reportedQuota: { capturedAt: snapshot.capturedAt, windows: snapshot.rateWindows },
          models: models.map(model => model.id), capacity: Math.min(1, rule.maxConcurrent), timeoutMs: 120000,
          busy: [...this.active.values()].some(row => row.attempt.profileId === rule.profileId),
          reasoningEfforts: Object.fromEntries(models.map(model => [model.id, model.reasoningEfforts!])) });
        this.unavailableUntil.delete(rule.profileId);
      } catch { this.unavailableUntil.set(rule.profileId, Date.now() + 60_000); }
    }));
    return result.sort((left, right) => left.profileId.localeCompare(right.profileId));
  }

  async authorize(input: Record<string, unknown>, clientId: string): Promise<string[]> {
    if (typeof input.profileId !== "string" || typeof input.originSessionId !== "string" ||
        !SAFE_ID.test(input.originSessionId) || typeof input.model !== "string" ||
        !["routine", "standard", "complex"].includes(String(input.complexity))) throw Error("codex_binding_invalid");
    const snapshot = await this.profiles.refreshProfile(input.profileId);
    this.snapshots.set(input.profileId, snapshot);
    return this.authorizeSnapshot(input, clientId, snapshot);
  }

  private async authorizeSnapshot(input: Record<string, unknown>, clientId: string, snapshot: CodexProfileSnapshot): Promise<string[]> {
    const actor = { clientId, sessionId: String(input.originSessionId) };
    const context = await this.origins.resolve(actor);
    const decision = await this.origins.evaluateSubscriptionDispatch(actor, snapshot.profileId, snapshot.accountIdentity);
    if (!decision.allowed || !context.resolved || !codexProfileFitsTask(snapshot, {
      modelId: String(input.model), reasoningEffort: String(input.reasoningEffort),
      complexity: input.complexity as "routine" | "standard" | "complex",
    })) throw Error(decision.reason ?? "codex_profile_ineligible");
    // The scheduler owns durable capacity. This policy check establishes only
    // operator enablement and native-origin protection, with no new reservation.
    const eligible = await this.policy.eligibleCandidates([snapshot.profileId], { [snapshot.profileId]: 0 }, context);
    if (!eligible.includes(snapshot.profileId)) throw Error("codex_pool_disabled");
    return context.protectedProfileIds;
  }

  private key(projectId: string, jobId: string, clientId: string): string {
    return JSON.stringify([projectId, jobId, clientId]);
  }

  async cancelJob(projectId: string, jobId: string, clientId: string): Promise<number> {
    this.cancelledJobs.add(this.key(projectId, jobId, clientId));
    let count = 0;
    for (const row of this.active.values()) {
      if (row.attempt.projectId !== projectId || row.attempt.jobId !== jobId || row.attempt.clientId !== clientId) continue;
      row.cancelled = true;
      count++;
      await row.handle?.cancel();
    }
    return count;
  }

  async cancelAll(): Promise<void> {
    this.closed = true;
    for (const row of this.active.values()) {
      row.cancelled = true;
      await row.handle?.cancel();
    }
  }

  private async update(operationId: string, patch: Partial<Attempt>): Promise<void> {
    await this.store.update(state => {
      const row = (state as AttemptState).codexDagAttempts?.[operationId];
      if (!row) throw Error("codex_attempt_missing");
      Object.assign(row, patch);
    });
  }

  async invoke(op: JobOperation): Promise<JobResult<Record<string, unknown>>> {
    const reject = (reason: string, ambiguous = false): JobResult<Record<string, unknown>> => ({
      accountId: op.selectedAccountId, classification: ambiguous ? "ambiguous" : "rejected", reason,
    });
    const input = op.input;
    if (op.kind !== "run_agent" || input.provider !== "codex" ||
        ![input.projectId, input.jobId, input.taskId, input.clientId].every(value => typeof value === "string" && /^[A-Za-z0-9_-][A-Za-z0-9._:-]{0,127}$/.test(value)) ||
        typeof input.profileId !== "string" || op.selectedAccountId !== "codex:" + input.profileId ||
        typeof input.prompt !== "string" || !input.prompt.trim() || Buffer.byteLength(input.prompt) > 16384 ||
        typeof input.expectedMarker !== "string" || !input.expectedMarker.trim() || input.expectedMarker !== input.expectedMarker.trim() || /[\r\n\0]/.test(input.expectedMarker) || input.expectedMarker.length > 256 ||
        !Number.isSafeInteger(input.timeoutMs) || Number(input.timeoutMs) < 1000 || Number(input.timeoutMs) > 120000 ||
        !/^[A-Za-z0-9_-]{16,128}$/.test(op.operationId)) return reject("codex_binding_invalid");
    const attempt: Attempt = { operationId: op.operationId, projectId: String(input.projectId), clientId: String(input.clientId),
      jobId: String(input.jobId), taskId: "dag-codex-" + createHash("sha256").update(op.operationId).digest("hex").slice(0,32),
      profileId: input.profileId, model: String(input.model), reasoningEffort: String(input.reasoningEffort),
      digest: createHash("sha256").update(JSON.stringify(input)).digest("hex"), status: "intent", requestStartedAt: Date.now() / 1000 };
    const row = { attempt, handle: undefined as CodexExecutionHandle | undefined, cancelled: false };
    if (this.closed || this.cancelledJobs.has(this.key(attempt.projectId, attempt.jobId, attempt.clientId))) return reject("codex_cancelled_before_launch");
    if (this.active.has(op.operationId)) return reject("codex_operation_already_active", true);
    this.active.set(op.operationId, row);
    let reserved = false;
    const workerActor = "client:codex-worker-" + createHash("sha256").update(attempt.clientId + ":" + attempt.profileId).digest("hex").slice(0,24);
    try {
      const protectedProfiles = await this.authorize(input, attempt.clientId);
      let existing: Attempt | undefined;
      await this.store.update(state => {
        const document = state as AttemptState;
        const attempts = document.codexDagAttempts ??= {};
        existing = attempts[op.operationId];
        if (existing) return;
        if (Object.keys(attempts).length >= 1000) throw Error("codex_attempt_capacity");
        attempts[op.operationId] = attempt;
        reserved = true;
      });
      if (existing) {
        if (existing.digest !== attempt.digest || existing.clientId !== attempt.clientId || existing.profileId !== attempt.profileId) return reject("codex_attempt_binding_changed", true);
        if (existing.status === "success" && existing.result) {
          const saved = await this.workspace.snapshot(attempt.projectId, workerActor);
          if (saved.artifacts.some((artifact: any) => artifact.id === existing!.result!.artifactId && artifact.taskId === attempt.taskId)) return { accountId: op.selectedAccountId, classification: "accepted", value: existing.result };
          return reject("codex_artifact_requires_reconciliation", true);
        }
        await this.update(op.operationId, { status: "ambiguous" });
        return reject("codex_attempt_requires_reconciliation", true);
      }
      if (row.cancelled || this.closed) throw Error("cancelled");
      const actor = "client:" + attempt.clientId;
      let snapshot = await this.workspace.snapshot(attempt.projectId, actor);
      if (!snapshot.participants.some((participant: any) => participant.id === actor)) {
        await this.workspace.update(attempt.projectId, actor, { action: "participant_upsert", label: "Job orchestrator", provider: "rotoxy",
          expectedRevision: snapshot.revision, idempotencyKey: attempt.taskId + "-owner" });
        snapshot = await this.workspace.snapshot(attempt.projectId, actor);
      }
      await this.workspace.update(attempt.projectId, actor, { action: "task_create", taskId: attempt.taskId, title: "Job task " + String(input.taskId),
        description: input.prompt, jobId: attempt.jobId, externalTaskId: input.taskId,
        expectedRevision: snapshot.revision, idempotencyKey: attempt.taskId + "-task" });
      snapshot = await this.workspace.snapshot(attempt.projectId, workerActor);
      const profileLabel = (await this.profiles.listProfiles()).find(profile => profile.id === attempt.profileId)?.label;
      await this.workspace.update(attempt.projectId, workerActor, { action: "participant_upsert", label: profileLabel ? "Codex · " + profileLabel : "Codex worker " + attempt.profileId.slice(0,8), provider: "codex", model: attempt.model,
        expectedRevision: snapshot.revision, idempotencyKey: attempt.taskId + "-worker" });
      snapshot = await this.workspace.snapshot(attempt.projectId, workerActor);
      await this.workspace.update(attempt.projectId, workerActor, { action: "task_claim", taskId: attempt.taskId,
        expectedRevision: snapshot.revision, idempotencyKey: attempt.taskId + "-claim" });
      if (row.cancelled || this.closed) throw Error("cancelled");
      await this.update(op.operationId, { status: "running" });
      row.handle = this.profiles.startExecution({ profileId: attempt.profileId, modelId: attempt.model,
        reasoningEffort: attempt.reasoningEffort, cwd: this.cwd, prompt: input.prompt, timeoutMs: Number(input.timeoutMs),
        origin: { callerId: attempt.taskId, protectedProfileIds: protectedProfiles },
        authorizeSnapshot: async fresh => { await this.authorizeSnapshot(input, attempt.clientId, fresh); if (row.cancelled || this.closed) throw Error("cancelled"); },
        onReceipt: receipt => this.update(op.operationId, receipt),
      });
      const recordApprovals = async () => {
        if (!row.handle?.pendingRequests.length) return;
        await this.update(op.operationId, { pendingApprovals: row.handle.pendingRequests.slice(0,16).map(request => ({
          requestId: String(request.id).slice(0,128), method: request.method.slice(0,128), observedAt: Date.now() / 1000,
        })) });
      };
      let approvalDetected = false;
      const approvalMonitor = setInterval(() => {
        if (approvalDetected || !row.handle?.pendingRequests.length) return;
        approvalDetected = true;
        void recordApprovals().catch(() => undefined).finally(() => row.handle?.cancel().catch(() => undefined));
      }, 250);
      let result;
      try { result = await row.handle.promise; } finally { clearInterval(approvalMonitor); await recordApprovals(); }
      if (row.handle.pendingRequests.length || row.cancelled || result.profileId !== attempt.profileId || result.modelId !== attempt.model ||
          result.reasoningEffort !== attempt.reasoningEffort || Buffer.byteLength(result.text) > 16384 ||
          result.text.split(/\r?\n/).filter(line => line.trim()).at(-1) !== input.expectedMarker) throw Error("codex_result_contract_failed");
      const artifactId = attempt.taskId + "-result";
      snapshot = await this.workspace.snapshot(attempt.projectId, workerActor);
      await this.workspace.update(attempt.projectId, workerActor, { action: "artifact_submit", taskId: attempt.taskId, artifactId,
        kind: "text", reference: result.text.slice(0,850), title: "Codex result · " + attempt.model,
        expectedRevision: snapshot.revision, idempotencyKey: artifactId });
      const value = { assistantText: result.text, reportedModel: result.modelId, profileId: result.profileId,
        attemptId: attempt.taskId, artifactId, threadId: result.threadId, turnId: result.turnId, reasoningEffort: result.reasoningEffort,
        requestStartedAt: attempt.requestStartedAt, assistantAt: Date.now() / 1000 };
      await this.update(op.operationId, { status: "success", result: value });
      return { accountId: op.selectedAccountId, classification: "accepted", value };
    } catch {
      if (reserved) {
        await this.update(op.operationId, { status: "ambiguous" }).catch(() => undefined);
        try {
          const actor = workerActor;
          const snapshot = await this.workspace.snapshot(attempt.projectId, actor);
          await this.workspace.update(attempt.projectId, actor, { action: "task_update", taskId: attempt.taskId, state: "blocked",
            note: "Codex execution requires review. Check native approval, cancellation and thread receipts before further work.",
            expectedRevision: snapshot.revision, idempotencyKey: attempt.taskId + "-blocked" });
        } catch { /* The durable attempt retains its ambiguous state. */ }
      }
      return reject(reserved ? "codex_attempt_requires_reconciliation" : "codex_origin_or_profile_unavailable", reserved);
    } finally { this.active.delete(op.operationId); }
  }
}

export class CompositeAgentJobs implements AgentJobExecutor {
  constructor(private readonly executors: AgentJobExecutor[]) {}
  async resources(): Promise<AgentResource[]> {
    return (await Promise.all(this.executors.map(executor => executor.resources()))).flat();
  }
  async authorize(input: Record<string, unknown>, clientId: string): Promise<unknown> {
    if (input.provider !== "codex") return;
    const executor = this.executors.find(candidate => candidate.provider === "codex");
    if (executor?.authorize) return executor.authorize(input, clientId);
    throw Error("codex_executor_unavailable");
  }
  async invoke(operation: JobOperation): Promise<JobResult<Record<string, unknown>>> {
    const provider = operation.selectedAccountId.startsWith("codex:") ? "codex" : operation.selectedAccountId.startsWith("claude-code:") ? "claude-code" : undefined;
    const pinned = this.executors.find(executor => executor.provider === provider);
    if (pinned) return pinned.invoke(operation);
    for (const executor of this.executors.filter(candidate => !candidate.provider)) {
      if ((await executor.resources()).some(resource => resource.accountId === operation.selectedAccountId)) return executor.invoke(operation);
    }
    return { accountId: operation.selectedAccountId, classification: "rejected", reason: "agent_provider_unavailable" };
  }
  async cancelJob(project: string, job: string, client: string): Promise<number> {
    return (await Promise.all(this.executors.map(executor => executor.cancelJob?.(project, job, client) ?? 0))).reduce((sum, count) => sum + count, 0);
  }
  async cancelAll(): Promise<void> { await Promise.all(this.executors.map(executor => executor.cancelAll?.())); }
}
