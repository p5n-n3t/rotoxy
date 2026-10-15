/**
 * Runtime tool-inventory collection: speaks just enough MCP (initialize,
 * notifications/initialized, paginated tools/list) with ONE upstream
 * credential to record which tools that account exposes. Only non-secret
 * metadata (names, descriptions, schema hashes, annotation hints) is stored.
 */

import { collectToolInventory, createCapabilitySnapshot } from "./provider-capabilities.js";
import { readBodyLimited, serverMessages } from "./jsonrpc-wire.js";
import type { JsonRpcMessage } from "./tool-policy.js";
import type { PersistedState, StoredCapabilities, StoredToolRecord, UpstreamAccount } from "./types.js";
import type { StateStore } from "./store.js";
import type { TelemetryRecorder } from "./telemetry.js";

const PROTOCOL_VERSION = "2025-06-18";
const MAX_DESCRIPTION = 600;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

interface RpcCall {
  message?: JsonRpcMessage;
  status: number;
  sessionId?: string;
}

async function rpc(
  state: PersistedState,
  token: string,
  body: JsonRpcMessage,
  sessionId: string | undefined,
): Promise<RpcCall> {
  const headers = new Headers({
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
    "x-token2oauth-inventory": "1",
  });
  const scheme = state.config.upstreamAuthScheme.trim();
  headers.set(state.config.upstreamAuthHeader, scheme ? scheme + " " + token : token);
  if (sessionId) {
    headers.set("mcp-session-id", sessionId);
    headers.set("mcp-protocol-version", PROTOCOL_VERSION);
  }
  const response = await fetch(state.config.upstreamUrl, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    redirect: "manual",
    signal: AbortSignal.timeout(Math.min(state.config.requestTimeoutMs, 30_000)),
  });
  const raw = await readBodyLimited(response, MAX_RESPONSE_BYTES);
  if (raw === undefined) throw new Error("upstream response exceeded " + MAX_RESPONSE_BYTES + " bytes");
  const text = raw.toString("utf8");
  const message = body.id === undefined
    ? undefined
    : serverMessages(response.headers.get("content-type"), text).find((m) => m.id === body.id);
  return { message, status: response.status, sessionId: response.headers.get("mcp-session-id") || undefined };
}

function toStored(records: ReturnType<typeof createCapabilitySnapshot>["inventory"]["tools"]): StoredToolRecord[] {
  return records.map((record) => {
    const hints = (record.annotations || {}) as Record<string, unknown>;
    return {
      name: record.name,
      title: record.title?.slice(0, 200),
      description: record.description ? record.description.slice(0, MAX_DESCRIPTION) : undefined,
      schemaHash: record.schemaHash,
      readOnlyHint: typeof hints.readOnlyHint === "boolean" ? hints.readOnlyHint : undefined,
      destructiveHint: typeof hints.destructiveHint === "boolean" ? hints.destructiveHint : undefined,
    };
  });
}

/** Collect and persist the tool inventory for one account. Never throws for upstream errors. */
export async function refreshAccountCapabilities(
  store: StateStore,
  accountId: string,
  telemetry?: TelemetryRecorder,
): Promise<StoredCapabilities> {
  const state = await store.load();
  const account = state.accounts.find((a) => a.id === accountId);
  if (!account) throw new Error("account not found");
  const startedAt = Date.now();
  const result = await collect(state, account, await store.revealToken(account));
  telemetry?.recordGateway({
    kind: "probe",
    method: "tools/list",
    accountId,
    latencyMs: Date.now() - startedAt,
    outcome: result.ok ? "success" : "error",
    errorClass: result.ok ? undefined : "inventory-failed",
    message: result.error,
  });
  await store.update((s) => {
    if (!s.accounts.some((a) => a.id === accountId)) return;
    s.capabilities = { ...(s.capabilities || {}), [accountId]: result };
  });
  return result;
}

async function collect(state: PersistedState, account: UpstreamAccount, token: string): Promise<StoredCapabilities> {
  const capturedAt = Date.now();
  if (!state.config.upstreamUrl) {
    return { capturedAt, ok: false, complete: false, error: "upstream URL is not configured", tools: [] };
  }
  if (!account.enabled) {
    return { capturedAt, ok: false, complete: false, error: "account is disabled", tools: [] };
  }
  let sessionId: string | undefined;
  try {
    const init = await rpc(state, token, {
      jsonrpc: "2.0",
      id: "t2o-inventory-init",
      method: "initialize",
      params: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "ROTOXY tool inventory", version: "0.2.0" },
      },
    }, undefined);
    if (init.status < 200 || init.status >= 300 || !init.message?.result) {
      return {
        capturedAt,
        ok: false,
        complete: false,
        error: init.message?.error?.message ? "initialize failed: " + String(init.message.error.message).slice(0, 200) : "initialize returned HTTP " + init.status,
        tools: [],
      };
    }
    sessionId = init.sessionId;
    const serverInfo = init.message.result.serverInfo || {};
    await rpc(state, token, { jsonrpc: "2.0", method: "notifications/initialized" }, sessionId);

    let page = 0;
    const inventory = await collectToolInventory(async (cursor) => {
      page += 1;
      const call = await rpc(state, token, {
        jsonrpc: "2.0",
        id: "t2o-inventory-tools-" + page,
        method: "tools/list",
        params: cursor ? { cursor } : {},
      }, sessionId);
      if (call.status < 200 || call.status >= 300) throw new Error("tools/list returned HTTP " + call.status);
      if (call.message?.error) throw new Error("tools/list error: " + String(call.message.error.message || "unknown").slice(0, 200));
      const result = call.message?.result || {};
      return { tools: Array.isArray(result.tools) ? result.tools : [], nextCursor: result.nextCursor };
    }, { maxPages: 20, maxTools: 2000 });

    const snapshot = createCapabilitySnapshot({
      provider: account.provider,
      accountId: account.id,
      accountLabel: account.label,
      serverUrl: state.config.upstreamUrl,
      inventory,
    });
    return {
      capturedAt,
      ok: inventory.complete,
      complete: inventory.complete,
      error: inventory.incompleteReason,
      surfaceHash: snapshot.surfaceHash,
      serverName: typeof serverInfo.name === "string" ? serverInfo.name.slice(0, 120) : undefined,
      serverVersion: typeof serverInfo.version === "string" ? serverInfo.version.slice(0, 60) : undefined,
      protocolVersion: typeof init.message.result.protocolVersion === "string" ? init.message.result.protocolVersion : undefined,
      tools: toStored(snapshot.inventory.tools),
    };
  } catch (error: any) {
    return {
      capturedAt,
      ok: false,
      complete: false,
      error: error?.name === "TimeoutError" ? "upstream request timed out" : String(error?.message || error).slice(0, 200),
      tools: [],
    };
  } finally {
    if (sessionId) {
      // Best effort: release the upstream session this inventory opened.
      const headers = new Headers({ "mcp-session-id": sessionId });
      const scheme = state.config.upstreamAuthScheme.trim();
      headers.set(state.config.upstreamAuthHeader, scheme ? scheme + " " + token : token);
      await fetch(state.config.upstreamUrl, { method: "DELETE", headers, signal: AbortSignal.timeout(5_000) }).catch(() => undefined);
    }
  }
}

export interface ToolCatalogEntry {
  name: string;
  title?: string;
  description?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  /** Accounts whose last inventory listed this tool. */
  accountIds: string[];
  /** True when accounts report different schemas for this tool name. */
  schemaDrift: boolean;
}

/** Union of every account's last inventory, sorted by tool name. */
export function toolCatalog(state: PersistedState): ToolCatalogEntry[] {
  const byName = new Map<string, ToolCatalogEntry & { hashes: Set<string> }>();
  for (const account of state.accounts) {
    const caps = state.capabilities?.[account.id];
    if (!caps) continue;
    for (const tool of caps.tools) {
      let entry = byName.get(tool.name);
      if (!entry) {
        entry = { name: tool.name, title: tool.title, description: tool.description, readOnlyHint: tool.readOnlyHint, destructiveHint: tool.destructiveHint, accountIds: [], schemaDrift: false, hashes: new Set() };
        byName.set(tool.name, entry);
      }
      entry.accountIds.push(account.id);
      entry.hashes.add(tool.schemaHash);
    }
  }
  return [...byName.values()]
    .map(({ hashes, ...entry }) => ({ ...entry, schemaDrift: hashes.size > 1 }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}
