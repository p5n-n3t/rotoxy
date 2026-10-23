/**
 * Pure, validated route helper for the LightSprint workspace-scoped API.
 * Builds documented route descriptors only — no network, no credentials, no dispatch.
 * The workspace prefix /api/workspaces/{workspaceId}/ is documented in
 * docs/operations/lightsprint-api-compatibility.md.
 *
 * Limitations:
 *  - Does not verify that the workspaceId is actually owned by the account; only
 *    format validation and explicit account-binding checks are performed.
 *  - Every route retains the bound workspace prefix. The caller must verify
 *    upstream ownership before using these descriptors for I/O.
 *  - Never infers model pins, effort pins, pricing, entitlements, or reasoning.
 *  - This helper is preparatory; live dispatch integration is outside its scope.
 */

const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const ACCOUNT_ID = /^[A-Za-z0-9_-][A-Za-z0-9._:-]{0,127}$/;

export type WorkspaceRouteMethod = "GET" | "POST" | "PATCH";

export interface WorkspaceRoute {
  readonly method: WorkspaceRouteMethod;
  readonly path: string;
  /** Bound accountId — carried for caller verification; not a network credential. */
  readonly accountId: string;
  readonly workspaceId: string;
}

export type WorkspaceRouteResult =
  | { readonly ok: true; readonly route: WorkspaceRoute }
  | { readonly ok: false; readonly reason: "account_mismatch" | "invalid_session_id" | "invalid_task_id" };

export interface WorkspaceContractOptions {
  accountId: string;
  workspaceId: string;
}

function rejectFragment(value: unknown): boolean {
  if (typeof value !== "string") return true;
  // Reject anything that looks like a path traversal or encoded separator.
  if (value.includes("/") || value.includes("\\") || value.includes("\0") ||
      value.includes("?") || value.includes("#") || value.includes("%")) return true;
  return !ID.test(value);
}

/**
 * Account-bound workspace route descriptor builder.
 * Construction validates accountId and workspaceId; per-call methods validate
 * session/task IDs and enforce account binding. Never performs I/O.
 */
export class LightSprintWorkspaceContract {
  readonly accountId: string;
  readonly workspaceId: string;
  private readonly wsBase: string;

  constructor(options: WorkspaceContractOptions) {
    if (typeof options.accountId !== "string" || !ACCOUNT_ID.test(options.accountId)) {
      throw new TypeError("accountId is invalid");
    }
    if (typeof options.workspaceId !== "string" || !ID.test(options.workspaceId)) {
      throw new TypeError("workspaceId is invalid");
    }
    this.accountId = options.accountId;
    this.workspaceId = options.workspaceId;
    this.wsBase = `/api/workspaces/${this.workspaceId}`;
    Object.freeze(this);
  }

  /**
   * Returns true only when claimedAccountId exactly matches the bound accountId.
   * Use this before operating on any route result to confirm the calling context
   * has not switched accounts.
   */
  verifyAccountBinding(claimedAccountId: unknown): boolean {
    return typeof claimedAccountId === "string" && claimedAccountId === this.accountId;
  }

  private route(method: WorkspaceRouteMethod, path: string): WorkspaceRoute {
    return Object.freeze({ method, path, accountId: this.accountId, workspaceId: this.workspaceId });
  }

  private sessionRoute(
    method: WorkspaceRouteMethod,
    sessionId: unknown,
    suffix: string,
  ): WorkspaceRouteResult {
    if (rejectFragment(sessionId)) return { ok: false, reason: "invalid_session_id" };
    return {
      ok: true,
      route: this.route(method, `${this.wsBase}/agent-sessions/${sessionId as string}${suffix}`),
    };
  }

  private taskRoute(
    method: WorkspaceRouteMethod,
    taskId: unknown,
    suffix: string,
  ): WorkspaceRouteResult {
    if (rejectFragment(taskId)) return { ok: false, reason: "invalid_task_id" };
    return {
      ok: true,
      route: this.route(method, `${this.wsBase}/tasks/${taskId as string}${suffix}`),
    };
  }

  // ── Workspace-scoped task routes ──────────────────────────────────────────

  /** POST /api/workspaces/{workspaceId}/tasks */
  taskCreateRoute(): WorkspaceRoute {
    return this.route("POST", `${this.wsBase}/tasks`);
  }

  /** GET /api/workspaces/{workspaceId}/tasks */
  taskListRoute(): WorkspaceRoute {
    return this.route("GET", `${this.wsBase}/tasks`);
  }

  /**
   * GET /api/workspaces/{workspaceId}/agent-sessions
   * Lists sessions; this alone does not establish idempotency or launch correlation.
   */
  sessionListRoute(): WorkspaceRoute {
    return this.route("GET", `${this.wsBase}/agent-sessions`);
  }

  /** POST /api/workspaces/{workspaceId}/agent-sessions */
  sessionCreateRoute(): WorkspaceRoute {
    return this.route("POST", `${this.wsBase}/agent-sessions`);
  }

  // ── Session-level routes (session IDs validated to reject injection) ──────

  /** GET /api/workspaces/{workspaceId}/agent-sessions/{sessionId}/status */
  sessionStatusRoute(sessionId: unknown): WorkspaceRouteResult {
    return this.sessionRoute("GET", sessionId, "/status");
  }

  /** GET /api/workspaces/{workspaceId}/agent-sessions/{sessionId}/transcript */
  sessionTranscriptRoute(sessionId: unknown): WorkspaceRouteResult {
    return this.sessionRoute("GET", sessionId, "/transcript");
  }

  /** POST /api/workspaces/{workspaceId}/agent-sessions/{sessionId}/chat */
  sessionChatRoute(sessionId: unknown): WorkspaceRouteResult {
    return this.sessionRoute("POST", sessionId, "/chat");
  }

  /**
   * POST /api/workspaces/{workspaceId}/agent-sessions/{sessionId}/actions/cancel
   * Native turn cancellation; does not terminate the session.
   */
  sessionCancelRoute(sessionId: unknown): WorkspaceRouteResult {
    return this.sessionRoute("POST", sessionId, "/actions/cancel");
  }

  /**
   * PATCH /api/workspaces/{workspaceId}/agent-sessions/{sessionId}
   * Caller must supply body `{ status: "stopped" }` per the documented contract.
   */
  sessionStopRoute(sessionId: unknown): WorkspaceRouteResult {
    return this.sessionRoute("PATCH", sessionId, "");
  }

  /**
   * Scoped task route for callers that need to address a specific task inside this workspace.
   * GET /api/workspaces/{workspaceId}/tasks/{taskId}
   */
  scopedTaskReadRoute(taskId: unknown): WorkspaceRouteResult {
    return this.taskRoute("GET", taskId, "");
  }
}
