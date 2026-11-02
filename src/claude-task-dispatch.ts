import { constants as fsConstants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import type { ClaudeCodeJobs, ClaudeCodeJobRequest, ClaudeCodeJobResult, ClaudeCodeSpawnHandle } from "./providers/claude-code-jobs.js";
import { CLAUDE_CODE_MAX_PROMPT_BYTES, ClaudeCodeJobError } from "./providers/claude-code-jobs.js";

const MAX_REGISTRY_BYTES = 64 * 1024;
const MAX_RESULT_BYTES = 512 * 1024;
const PROFILE_ID = /^[A-Za-z0-9_-]{16,48}$/;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9_.:+/@-]{0,159}$/;

type RunnerProfile = {
  id: string; kind: "claude"; cwd: string; binary: string;
  enabled: boolean; allowedModels: string[];
};

export type ClaudeTaskDispatchErrorCode =
  | "registry_unavailable" | "registry_invalid" | "profile_not_found"
  | "profile_disabled" | "model_not_allowed" | "path_not_allowed"
  | "invalid_request" | "result_too_large";

export class ClaudeTaskDispatchError extends Error {
  constructor(readonly code: ClaudeTaskDispatchErrorCode, readonly ambiguous = false) {
    super(code);
    this.name = "ClaudeTaskDispatchError";
  }
}

export type ClaudeTaskDispatchRequest = {
  /** Selects an existing owner-configured profile; executable and cwd never come from task input. */
  profileId: string;
  prompt: string;
  /** Optional request, checked against the selected profile's owner-configured model list. */
  model?: string;
  timeoutMs?: number;
};

export type ClaudeTaskDispatchHandle = Pick<ClaudeCodeSpawnHandle, "runId" | "cancel"> & {
  profileId: string;
  model: string;
  promise: Promise<ClaudeCodeJobResult>;
};

export interface ClaudeTaskDispatchOptions {
  /** Existing private runner-profiles.json path. This service never writes it. */
  registryPath: string;
  /** The exact host-installed executable allowlist, supplied by server wiring. */
  allowedExecutables: readonly string[];
  /** Explicit workspace directories approved by server wiring. */
  allowedCwds: readonly string[];
  jobs: Pick<ClaudeCodeJobs, "start">;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unavailablePath(path: string, allowlist: readonly string[]): boolean {
  return !isAbsolute(path) || !allowlist.includes(path) || path.includes("\0");
}

async function readPrivateRegistry(path: string): Promise<unknown> {
  if (!isAbsolute(path) || path.includes("\0")) throw new ClaudeTaskDispatchError("registry_unavailable");
  let before, parent;
  try { [before, parent] = await Promise.all([lstat(path), lstat(dirname(path))]); } catch { throw new ClaudeTaskDispatchError("registry_unavailable"); }
  if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== process.getuid?.() || (parent.mode & 0o077) !== 0) throw new ClaudeTaskDispatchError("registry_invalid");
  if (!before.isFile() || before.isSymbolicLink() || before.uid !== process.getuid?.() || (before.mode & 0o077) !== 0 || before.size > MAX_REGISTRY_BYTES) {
    throw new ClaudeTaskDispatchError("registry_invalid");
  }
  let handle;
  try { handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0)); }
  catch { throw new ClaudeTaskDispatchError("registry_unavailable"); }
  try {
    const after = await handle.stat();
    if (!after.isFile() || after.uid !== process.getuid?.() || after.dev !== before.dev || after.ino !== before.ino || after.size > MAX_REGISTRY_BYTES) {
      throw new ClaudeTaskDispatchError("registry_invalid");
    }
    const bytes = await handle.readFile();
    if (bytes.byteLength > MAX_REGISTRY_BYTES) throw new ClaudeTaskDispatchError("registry_invalid");
    try { return JSON.parse(bytes.toString("utf8")); }
    catch { throw new ClaudeTaskDispatchError("registry_invalid"); }
  } finally { await handle.close(); }
}

function profilesFromRegistry(value: unknown): RunnerProfile[] {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.profiles) || value.profiles.length > 40) {
    throw new ClaudeTaskDispatchError("registry_invalid");
  }
  const seen = new Set<string>();
  const profiles: RunnerProfile[] = [];
  for (const raw of value.profiles) {
    if (!isRecord(raw) || Object.keys(raw).sort().join(",") !== "allowedModels,binary,cwd,enabled,id,kind,label,probeAt,probeCheck,probeOutput,probeState" ||
        typeof raw.id !== "string" || !PROFILE_ID.test(raw.id) || seen.has(raw.id) || !["claude", "opencode", "hermes"].includes(String(raw.kind)) ||
        typeof raw.label !== "string" || !raw.label.trim() || raw.label.trim() !== raw.label || raw.label.length > 80 || /[\x00-\x1f\x7f]/.test(raw.label) ||
        typeof raw.cwd !== "string" || !isAbsolute(raw.cwd) || typeof raw.binary !== "string" || !isAbsolute(raw.binary) || typeof raw.enabled !== "boolean" ||
        !Array.isArray(raw.allowedModels) || raw.allowedModels.length > 100 ||
        raw.allowedModels.some(model => typeof model !== "string" || !MODEL_ID.test(model)) ||
        typeof raw.probeState !== "string" || !["unverified", "available", "unavailable", "timeout", "output_limited"].includes(raw.probeState) ||
        !(raw.probeCheck === null || raw.probeCheck === "version" || raw.probeCheck === "help") ||
        !(raw.probeAt === null || Number.isSafeInteger(raw.probeAt) && Number(raw.probeAt) >= 0) ||
        typeof raw.probeOutput !== "string" || Buffer.byteLength(raw.probeOutput) > 1024) {
      throw new ClaudeTaskDispatchError("registry_invalid");
    }
    if (new Set(raw.allowedModels).size !== raw.allowedModels.length) throw new ClaudeTaskDispatchError("registry_invalid");
    seen.add(raw.id);
    if (raw.kind === "claude") profiles.push({ id: raw.id, kind: "claude", cwd: raw.cwd, binary: raw.binary, enabled: raw.enabled, allowedModels: raw.allowedModels as string[] });
  }
  return profiles;
}

/** Resolves trusted profile metadata and delegates all process ownership to ClaudeCodeJobs. */
export class ClaudeTaskDispatch {
  constructor(private readonly options: ClaudeTaskDispatchOptions) {
    if (!isAbsolute(options.registryPath) || options.registryPath.includes("\0") ||
        options.allowedExecutables.some(path => !isAbsolute(path) || path.includes("\0")) ||
        options.allowedCwds.some(path => !isAbsolute(path) || path.includes("\0"))) throw new TypeError("invalid Claude task dispatch configuration");
  }

  async start(request: ClaudeTaskDispatchRequest): Promise<ClaudeTaskDispatchHandle> {
    if (!request || typeof request !== "object" || !PROFILE_ID.test(request.profileId) ||
        typeof request.prompt !== "string" || !request.prompt.length || request.prompt.includes("\0") ||
        Buffer.byteLength(request.prompt, "utf8") > CLAUDE_CODE_MAX_PROMPT_BYTES ||
        request.model !== undefined && (typeof request.model !== "string" || !MODEL_ID.test(request.model)) ||
        request.timeoutMs !== undefined && (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs < 100 || request.timeoutMs > 15 * 60_000)) {
      throw new ClaudeTaskDispatchError("invalid_request");
    }
    const profiles = profilesFromRegistry(await readPrivateRegistry(this.options.registryPath));
    const profile = profiles.find(candidate => candidate.id === request.profileId);
    if (!profile) throw new ClaudeTaskDispatchError("profile_not_found");
    if (!profile.enabled) throw new ClaudeTaskDispatchError("profile_disabled");
    if (unavailablePath(profile.binary, this.options.allowedExecutables) || unavailablePath(profile.cwd, this.options.allowedCwds)) {
      throw new ClaudeTaskDispatchError("path_not_allowed");
    }
    const model = request.model ?? profile.allowedModels[0];
    if (!model || !profile.allowedModels.includes(model)) throw new ClaudeTaskDispatchError("model_not_allowed");
    const jobRequest: ClaudeCodeJobRequest = {
      executable: profile.binary,
      cwd: profile.cwd,
      prompt: request.prompt,
      model,
      ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
    };
    const handle = this.options.jobs.start(jobRequest);
    const promise = handle.promise.then(result => {
      if (Buffer.byteLength(result.text, "utf8") > MAX_RESULT_BYTES) throw new ClaudeTaskDispatchError("result_too_large", true);
      return result;
    });
    return { runId: handle.runId, cancel: () => handle.cancel(), profileId: profile.id, model, promise };
  }
}
