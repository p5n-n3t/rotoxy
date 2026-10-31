import { createHash } from "node:crypto";
import { LightSprintJobsAdapter, type JobProvider, type JobResult } from "./lightsprint-jobs.js";

/**
 * Binds every worker operation to one provider-verified LightSprint workspace.
 * This is deliberately a thin structural adapter: it exposes the durable
 * worker interface without allowing callers to substitute a workspace ID.
 */
export function workspaceBranchName(taskId: string): string {
  return `rotoxy-${createHash("sha256").update(taskId).digest("hex").slice(0, 24)}`;
}

export class LightSprintWorkspacePinnedJobsAdapter {
  readonly accountId: string;

  constructor(private readonly upstream: LightSprintJobsAdapter, readonly workspaceId: string) {
    this.accountId = upstream.accountId;
  }

  sessionStatus(sessionId: string): Promise<JobResult> {
    return this.upstream.workspaceSessionStatus(this.workspaceId, sessionId);
  }

  sessionTranscript(sessionId: string): Promise<JobResult> {
    return this.upstream.workspaceSessionTranscript(this.workspaceId, sessionId);
  }

  sendMessage(sessionId: string, message: string, clientMessageId: string): Promise<JobResult> {
    return this.upstream.sendWorkspaceMessage(this.workspaceId, sessionId, message, clientMessageId);
  }

  stopSession(sessionId: string): Promise<JobResult> {
    return this.upstream.stopWorkspaceSession(this.workspaceId, sessionId);
  }

  createTask(title: string, stackId: string): Promise<JobResult> {
    return this.upstream.createWorkspaceTask(this.workspaceId, title, stackId);
  }

  patchTaskInstructions(taskId: string, description: string): Promise<JobResult> {
    return this.upstream.patchWorkspaceTaskInstructions(this.workspaceId, taskId, description);
  }

  readTask(taskId: string): Promise<JobResult> {
    return this.upstream.readWorkspaceTask(this.workspaceId, taskId);
  }

  launchTask(taskId: string, provider: string): Promise<JobResult> {
    if (provider !== "claude" && provider !== "codex" && provider !== "auto" && provider !== "pi") throw new TypeError("provider is invalid");
    // LightSprint's documented workspace launch requires a branch label, but
    // it exposes neither a model nor effort selector. Derive a bounded label
    // from the task identity; it is not a caller-controlled branch path.
    return this.upstream.launchWorkspaceSession(this.workspaceId, taskId, provider as JobProvider, workspaceBranchName(taskId));
  }

  /** Durable worker path: verification instructions are loaded from the claimed operation, not adapter-local memory. */
  launchVerifiedTask(taskId: string, provider: string, expectedInstructions: string): Promise<JobResult> {
    if (provider !== "claude" && provider !== "codex" && provider !== "auto" && provider !== "pi") throw new TypeError("provider is invalid");
    return this.upstream.launchWorkspaceSession(this.workspaceId, taskId, provider as JobProvider, workspaceBranchName(taskId), expectedInstructions);
  }
}
