import test from "node:test";
import assert from "node:assert/strict";
import { LightSprintJobsAdapter } from "../dist/providers/lightsprint-jobs.js";

const ACCOUNT_ID = "acct_owner_7";
const TASK_ID = "task_123";
const SESSION_ID = "session_456";
const PINNED_TOKEN = "mock-secret-never-log";

function store() {
  return {
    async load() {
      return { accounts: [{ id: ACCOUNT_ID, provider: "lightsprint", enabled: true }] };
    },
    async revealToken(account) {
      assert.equal(account.id, ACCOUNT_ID);
      return PINNED_TOKEN;
    },
  };
}
function clientFactory(handler) {
  return () => ({ request: handler });
}
function ok(value) {
  return { structuredContent: value, isError: false };
}

test("native MCP transport stays account-pinned and uses initialize/session/tool-call framing", async () => {
  const seen = [];
  const fetch = async (url, init) => {
    const request = JSON.parse(init.body);
    seen.push({ url: String(url), request, auth: new Headers(init.headers).get("authorization"), session: new Headers(init.headers).get("mcp-session-id"), redirect: init.redirect });
    if (request.method === "initialize") {
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: "2025-06-18" } }), {
        status: 200,
        headers: { "content-type": "application/json", "mcp-session-id": "owned-session" },
      });
    }
    if (request.method === "notifications/initialized") return new Response(null, { status: 202 });
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: ok([{ id: TASK_ID }]) }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const adapter = new LightSprintJobsAdapter(store(), ACCOUNT_ID, { fetch });
  const result = await adapter.listTaskAgents(TASK_ID);
  assert.equal(result.classification, "accepted");
  assert.equal(result.accountId, ACCOUNT_ID);
  assert.deepEqual(result.value, [{ id: TASK_ID }]);
  assert.equal(seen[0].request.method, "initialize");
  assert.equal(seen[0].request.id, 1);
  assert.equal(seen[1].request.method, "notifications/initialized");
  assert.equal(seen[2].request.method, "tools/call");
  assert.equal(seen[2].request.id, 2);
  assert.equal(seen[2].request.params.name, "lightsprint_api");
  assert.equal(seen[2].request.params.arguments.path, `/api/tasks/${TASK_ID}/lightsprint-agents`);
  assert.ok(seen.every((request) => request.url === "https://app.lightsprint.ai/mcp"));
  assert.ok(seen.every((request) => request.auth === `Bearer ${PINNED_TOKEN}`));
  assert.ok(seen.every((request) => request.redirect === "error"));
  assert.equal(seen[2].session, "owned-session");
});

test("chat sends only the requested current message and clientMessageId", async () => {
  let call;
  const adapter = new LightSprintJobsAdapter(store(), ACCOUNT_ID, {
    clientFactory: clientFactory(async (_method, params) => {
      call = params;
      return ok({ accepted: true });
    }),
  });
  const result = await adapter.sendMessage(SESSION_ID, "Please review the current patch.", "msg-20261010-1");
  assert.equal(result.classification, "accepted");
  assert.deepEqual(call, {
    name: "lightsprint_api",
    arguments: {
      method: "POST",
      path: `/api/agent-sessions/${SESSION_ID}/chat`,
      body: { message: "Please review the current patch.", clientMessageId: "msg-20261010-1" },
    },
  });
});

test("lost launch response is ambiguous and is never replayed", async () => {
  let launchCalls = 0;
  const adapter = new LightSprintJobsAdapter(store(), ACCOUNT_ID, {
    clientFactory: clientFactory(async (_method, params) => {
      const { method, path } = params.arguments;
      if (method === "PATCH") return ok({ id: TASK_ID, description: "Reviewed exact instructions." });
      if (method === "GET") return ok({ id: TASK_ID, description: "Reviewed exact instructions." });
      if (path.endsWith("/lightsprint-agents/claude")) {
        launchCalls += 1;
        throw new Error("response lost after request");
      }
      throw new Error("unexpected request");
    }),
  });
  assert.equal((await adapter.patchTaskInstructions(TASK_ID, "Reviewed exact instructions.")).classification, "accepted");
  const result = await adapter.launchTask(TASK_ID, "claude");
  assert.equal(result.classification, "ambiguous");
  assert.equal(result.reason, "transport_ambiguous");
  assert.equal(launchCalls, 1);
});

test("HTTP 200 tool errors carrying status 402 classify as quota, without echoing the body", async () => {
  const adapter = new LightSprintJobsAdapter(store(), ACCOUNT_ID, {
    clientFactory: clientFactory(async () => ({ isError: true, structuredContent: { status: 402, error: "private upstream message" } })),
  });
  const result = await adapter.readTask(TASK_ID);
  assert.equal(result.classification, "rejected");
  assert.equal(result.reason, "quota");
  assert.equal(result.httpStatus, 402);
  assert.equal(JSON.stringify(result).includes("private upstream message"), false);
});

test("instruction mismatch after readback prevents launch", async () => {
  let launchCalls = 0;
  const adapter = new LightSprintJobsAdapter(store(), ACCOUNT_ID, {
    clientFactory: clientFactory(async (_method, params) => {
      const { method, path } = params.arguments;
      if (method === "PATCH") return ok({ id: TASK_ID, description: "Intended instructions." });
      if (method === "GET") return ok({ id: TASK_ID, description: "Server kept stale instructions." });
      if (path.includes("/lightsprint-agents/")) launchCalls += 1;
      return ok({});
    }),
  });
  const patched = await adapter.patchTaskInstructions(TASK_ID, "Intended instructions.");
  assert.equal(patched.classification, "rejected");
  assert.equal(patched.reason, "instructions_mismatch");
  const launched = await adapter.launchTask(TASK_ID, "claude");
  assert.equal(launched.classification, "rejected");
  assert.equal(launchCalls, 0);
});

test("input IDs and arbitrary provider URLs are not accepted", async () => {
  const adapter = new LightSprintJobsAdapter(store(), ACCOUNT_ID, {
    clientFactory: () => ({ request: async () => ok({}) }),
  });
  assert.throws(() => adapter.readTask("../other"), /taskId is invalid/);
  await assert.rejects(async () => {
    const { createLightSprintMcpClient } = await import("../dist/providers/lightsprint-jobs.js");
    createLightSprintMcpClient({ endpoint: new URL("https://attacker.example/mcp"), token: PINNED_TOKEN, fetch: globalThis.fetch, timeoutMs: 1_000 });
  }, /unsafe LightSprint MCP endpoint/);
});

test("task/session operations use documented account-scoped routes and bound transcript output", async () => {
  const calls = [];
  const adapter = new LightSprintJobsAdapter(store(), ACCOUNT_ID, {
    clientFactory: clientFactory(async (_method, params) => {
      calls.push(params.arguments);
      if (params.arguments.path.endsWith("/transcript")) return ok({ transcript: "x".repeat(260_000) });
      return ok({ id: TASK_ID });
    }),
  });
  assert.equal((await adapter.createTask("Bounded title", "stack_1")).classification, "accepted");
  await adapter.readTask(TASK_ID);
  await adapter.listTaskAgents(TASK_ID);
  await adapter.sessionStatus(SESSION_ID);
  const transcript = await adapter.sessionTranscript(SESSION_ID);
  assert.equal(transcript.value.truncated, true);
  assert.ok(transcript.value.preview.length <= 250_000);
  await adapter.cancelTurn(SESSION_ID);
  await adapter.stopSession(SESSION_ID);
  assert.deepEqual(calls.map(({ method, path }) => [method, path]), [
    ["POST", "/api/tasks"],
    ["GET", `/api/tasks/${TASK_ID}`],
    ["GET", `/api/tasks/${TASK_ID}/lightsprint-agents`],
    ["GET", `/api/agent-sessions/${SESSION_ID}/status`],
    ["GET", `/api/agent-sessions/${SESSION_ID}/transcript`],
    ["POST", `/api/agent-sessions/${SESSION_ID}/cancel`],
    ["POST", `/api/agent-sessions/${SESSION_ID}/stop`],
  ]);
  assert.deepEqual(calls[0].body, { title: "Bounded title", scope: "stack", stackId: "stack_1" });
});

test("legacy generic accounts are accepted only for a canonical configured native LightSprint URL", async () => {
  let call;
  const legacyStore = {
    async load() {
      return {
        config: { upstreamUrl: "https://APP.LIGHTSPRINT.AI:443/mcp" },
        accounts: [{ id: ACCOUNT_ID, provider: "generic-bearer-mcp", enabled: true }],
      };
    },
    async revealToken(account) {
      assert.equal(account.id, ACCOUNT_ID);
      return PINNED_TOKEN;
    },
  };
  const adapter = new LightSprintJobsAdapter(legacyStore, ACCOUNT_ID, {
    clientFactory: (options) => {
      assert.equal(options.endpoint.href, "https://app.lightsprint.ai/mcp");
      assert.equal(options.token, PINNED_TOKEN);
      return { request: async (_method, params) => { call = params; return ok({ task: "created" }); } };
    },
  });
  const result = await adapter.createTask("Legacy compatible", "stack_1");
  assert.equal(result.classification, "accepted");
  assert.equal(call.arguments.path, "/api/tasks");
});

test("legacy generic accounts with non-native targets are rejected before client creation", async () => {
  for (const upstreamUrl of [
    "https://other.example/mcp",
    "http://app.lightsprint.ai/mcp",
    "https://app.lightsprint.ai/mcp/",
    "https://app.lightsprint.ai/mcp?tenant=other",
    "https://user:pass@app.lightsprint.ai/mcp",
  ]) {
    let factories = 0;
    const legacyStore = {
      async load() {
        return { config: { upstreamUrl }, accounts: [{ id: ACCOUNT_ID, provider: "generic-bearer-mcp", enabled: true }] };
      },
      async revealToken() { assert.fail("mismatched target must be rejected before reading credential"); },
    };
    const adapter = new LightSprintJobsAdapter(legacyStore, ACCOUNT_ID, {
      clientFactory: () => { factories += 1; return { request: async () => ok({}) }; },
    });
    const result = await adapter.readTask(TASK_ID);
    assert.equal(result.classification, "rejected");
    assert.equal(result.reason, "endpoint_mismatch");
    assert.equal(factories, 0);
  }
});

test("cached client revalidates enabled state before each call and token rotation rebuilds it", async () => {
  const state = {
    config: { upstreamUrl: "https://provider.example/mcp" },
    accounts: [{ id: ACCOUNT_ID, provider: "lightsprint", enabled: true }],
  };
  let token = "first-token";
  let factoryCalls = 0;
  let requestCalls = 0;
  const adapter = new LightSprintJobsAdapter({
    async load() { return state; },
    async revealToken() { return token; },
  }, ACCOUNT_ID, {
    clientFactory: ({ token: received }) => {
      factoryCalls += 1;
      return { request: async () => { requestCalls += 1; return ok({ ok: true }); }, received };
    },
  });
  assert.equal((await adapter.readTask(TASK_ID)).classification, "accepted");
  token = "rotated-token";
  assert.equal((await adapter.readTask(TASK_ID)).classification, "accepted");
  assert.equal(factoryCalls, 2);
  state.accounts[0].enabled = false;
  const disabled = await adapter.readTask(TASK_ID);
  assert.equal(disabled.classification, "rejected");
  assert.equal(disabled.reason, "account_unavailable");
  assert.equal(factoryCalls, 2);
  assert.equal(requestCalls, 2);
});

test("recent transcript projection preserves the newest assistant marker and timestamp, not old tool blobs", async () => {
  const history = [
    { role: "tool", timestamp: "2026-10-10T10:00:00Z", content: "old-tool-payload-".repeat(50_000) },
    ...Array.from({ length: 140 }, (_, index) => ({ role: "user", timestamp: `2026-10-10T10:${String(index % 60).padStart(2, "0")}:00Z`, content: `older-${index}` })),
    { role: "assistant", timestamp: "2026-10-10T11:59:59Z", content: "TASK_COMPLETE: current dispatch finished" },
  ];
  const adapter = new LightSprintJobsAdapter(store(), ACCOUNT_ID, {
    clientFactory: clientFactory(async () => ok({ messages: history, unrelated: "metadata" })),
  });
  const result = await adapter.sessionTranscript(SESSION_ID);
  const transcript = result.value;
  const latest = transcript.messages[transcript.latestAssistantIndex];
  assert.equal(transcript.latestAssistantComplete, true);
  assert.equal(latest.role, "assistant");
  assert.equal(latest.timestamp, "2026-10-10T11:59:59Z");
  assert.equal(latest.content, "TASK_COMPLETE: current dispatch finished");
  assert.ok(transcript.omittedMessageCount > 0);
  assert.equal(transcript.omittedToolContentCount, 1);
  assert.equal(JSON.stringify(transcript).includes("tool_payload"), false);
  assert.ok(Buffer.byteLength(JSON.stringify(transcript), "utf8") <= 256 * 1024);
  assert.equal(JSON.stringify(transcript).includes("old-tool-payload"), false);
});

test("oversized newest assistant message is incomplete and never exposed as a truncated marker", async () => {
  const oversized = `TASK_COMPLETE:${"x".repeat(60_000)}`;
  const adapter = new LightSprintJobsAdapter(store(), ACCOUNT_ID, {
    clientFactory: clientFactory(async () => ok({ messages: [
      { role: "assistant", timestamp: "2026-10-10T12:00:00Z", content: oversized },
    ] })),
  });
  const transcript = (await adapter.sessionTranscript(SESSION_ID)).value;
  const latest = transcript.messages[transcript.latestAssistantIndex];
  assert.equal(transcript.latestAssistantComplete, false);
  assert.equal(transcript.incomplete, true);
  assert.equal(latest.timestamp, "2026-10-10T12:00:00Z");
  assert.equal(latest.contentOmitted, "oversized");
  assert.equal(latest.complete, false);
  assert.equal(Object.hasOwn(latest, "content"), false);
  assert.equal(JSON.stringify(transcript).includes("TASK_COMPLETE:"), false);
});

test("unknown transcript shape is a bounded preview and cannot claim a completion message", async () => {
  const adapter = new LightSprintJobsAdapter(store(), ACCOUNT_ID, {
    clientFactory: clientFactory(async () => ok({ entries: [{ text: "legacy-shape".repeat(100_000) }] })),
  });
  const transcript = (await adapter.sessionTranscript(SESSION_ID)).value;
  assert.equal(transcript.shape, "unknown");
  assert.equal(transcript.truncated, true);
  assert.equal(transcript.incomplete, true);
  assert.equal(transcript.latestAssistantComplete, false);
  assert.ok(Buffer.byteLength(transcript.preview, "utf8") <= 8 * 1024);
});

test("wire response above the existing byte limit returns an explicit bounded error", async () => {
  let requests = 0;
  const fetch = async (_url, init) => {
    requests += 1;
    const rpc = JSON.parse(init.body);
    if (rpc.method === "initialize") return new Response(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result: {} }), { status: 200, headers: { "content-type": "application/json" } });
    if (rpc.method === "notifications/initialized") return new Response(null, { status: 202 });
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result: { content: [{ type: "text", text: "x".repeat(1_100_000) }] } }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const adapter = new LightSprintJobsAdapter(store(), ACCOUNT_ID, { fetch });
  const result = await adapter.sessionTranscript(SESSION_ID);
  assert.equal(result.classification, "rejected");
  assert.equal(result.reason, "response_too_large");
  assert.equal(requests, 3);
});


test("live gateway tool policy also fences internal job adapter mutations", async () => {
  const backing = store();
  let policy; let calls = 0;
  const guarded = { ...backing, load: async () => ({ ...await backing.load(), config: { toolPolicy: policy } }) };
  const adapter = new LightSprintJobsAdapter(guarded, ACCOUNT_ID, { clientFactory: clientFactory(async () => { calls++; return ok({ accepted: true }); }) });
  assert.equal((await adapter.sendMessage(SESSION_ID, "one", "allowed-first")).classification, "accepted");
  policy = { endpoints: [{ tool: "lightsprint_api", rules: [
    { methods: ["GET"], path: "/api/agent-sessions/{sessionId}/status" },
    { methods: ["POST"], path: "/api/agent-sessions/{sessionId}/cancel" },
  ] }] };
  const blocked = await adapter.sendMessage(SESSION_ID, "two", "denied-second");
  assert.equal(blocked.classification, "rejected");
  assert.equal(blocked.reason, "policy_denied");
  assert.equal(calls, 1);
  assert.equal((await adapter.sessionStatus(SESSION_ID)).classification, "accepted");
  assert.equal((await adapter.cancelTurn(SESSION_ID)).classification, "accepted");
  assert.equal(calls, 3);
});

test("a single-use trusted permit authorizes only its exact claimed chat request after global denial", async () => {
  const backing = store(); let calls = 0; let permitCalls = 0; let unused = true;
  const expected = Object.freeze({ path: `/api/agent-sessions/${SESSION_ID}/chat`, message: "approved claimed work", clientMessageId: "attempt:1" });
  const guarded = { ...backing, load: async () => ({ ...await backing.load(), config: { toolPolicy: { endpoints: [
    { tool: "lightsprint_api", rules: [{ methods: ["GET"], path: "/api/agent-sessions/{sessionId}/status" }] },
  ] } } }) };
  const adapter = new LightSprintJobsAdapter(guarded, ACCOUNT_ID, {
    clientFactory: clientFactory(async () => { calls++; return ok({ accepted: true }); }),
    trustedChatMutationPermit: (request) => {
      permitCalls++;
      if (!unused || request.method !== "POST" || request.path !== expected.path ||
          request.body.message !== expected.message || request.body.clientMessageId !== expected.clientMessageId) return false;
      unused = false;
      return true;
    },
  });
  assert.equal((await adapter.sendMessage(SESSION_ID, "wrong message", "attempt:1")).reason, "policy_denied");
  assert.equal((await adapter.sendMessage("other-session", expected.message, expected.clientMessageId)).reason, "policy_denied");
  assert.equal((await adapter.sendMessage(SESSION_ID, expected.message, expected.clientMessageId)).classification, "accepted");
  assert.equal((await adapter.sendMessage(SESSION_ID, expected.message, expected.clientMessageId)).reason, "policy_denied");
  // Other methods cannot present this permit, even if their verb is mutating.
  assert.equal((await adapter.cancelTurn(SESSION_ID)).reason, "policy_denied");
  assert.equal(permitCalls, 4); // wrong message, wrong session, accepted exact request, replay
  assert.equal(calls, 1);
});

test("documented item transcript anchors last assistant snapshot to newest user turn", async () => {
  const items = [
    {seq: 40, turnId: 'old-turn', type: 'assistant_snapshot', time: '2026-10-15T10:00:00Z', payload: {content: 'stale'}},
    {seq: 41, turnId: 'new-turn', type: 'user_message', time: '2026-10-15T10:01:00Z',
      payload: {content: 'api_key=should-never-appear'}},
    {seq: 42, turnId: 'new-turn', type: 'assistant_snapshot', time: '2026-10-15T10:02:00Z',
      payload: {content: 'EXPECTED completed output'}},
  ];
  const adapter = new LightSprintJobsAdapter(store(), ACCOUNT_ID, {
    clientFactory: clientFactory(async () => ok({items, prevCursor: 40, nextCursor: 42, hasMore: true})),
  });
  const result = (await adapter.sessionTranscript(SESSION_ID)).value;
  assert.equal(result.shape, 'items');
  assert.equal(result.latestAssistantComplete, true);
  assert.equal(result.messages[result.latestAssistantIndex].content, 'EXPECTED completed output');
  assert.equal(result.messages[0].turnId, 'new-turn');
  assert.equal(result.hasMore, true);
  assert.equal(result.truncated, true);
  assert.equal(JSON.stringify(result).includes('should-never-appear'), false);
});

test("newer user turn or truncated turn cannot complete from older snapshot", async () => {
  const cases = [
    [
      {seq: 10, turnId:'old', type:'user_message',time:'2026-10-15T10:00:00Z',payload:{content:'old'}},
      {seq: 11, turnId:'old', type:'assistant_snapshot',time:'2026-10-15T10:00:10Z',payload:{content:'EXPECTED'}},
      {seq: 12, turnId:'new', type:'user_message',time:'2026-10-15T10:02:00Z',payload:{content:'new'}},
    ],
    [
      {seq: 10, turnId:'latest', type:'user_message',time:'2026-10-15T10:00:00Z',payload:{content:'new'}},
      {seq: 11, turnId:'latest', type:'assistant_snapshot',time:'2026-10-15T10:00:10Z',payload:{content:'EXPECTED'}},
      {seq: 12, turnId:'latest', type:'turn_truncated',time:'2026-10-15T10:00:11Z',payload:{reason:'truncated'}},
    ],
  ];
  for (const items of cases) {
    const adapter = new LightSprintJobsAdapter(store(), ACCOUNT_ID, {
      clientFactory: clientFactory(async () => ok({items, hasMore: true, nextCursor:12, prevCursor:10})),
    });
    const result = (await adapter.sessionTranscript(SESSION_ID)).value;
    assert.equal(result.latestAssistantComplete, false);
    assert.equal(result.incomplete, true);
    assert.equal(result.messages.length, 0);
  }
});

test("token transcript without newest user turn remains incomplete until supported older pagination", async () => {
  const adapter = new LightSprintJobsAdapter(store(), ACCOUNT_ID, {
    clientFactory: clientFactory(async () => ok({items: [
      {seq:50,turnId:'prior',type:'assistant_snapshot',time:'2026-10-15T10:00:00Z',payload:{content:'EXPECTED'}},
    ],prevCursor:49,nextCursor:50,hasMore:true})),
  });
  const result = (await adapter.sessionTranscript(SESSION_ID)).value;
  assert.equal(result.reason, 'missing_user_turn');
  assert.equal(result.latestAssistantComplete, false);
});
