import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHmac, randomBytes } from "node:crypto";
import { McpJobEvents, McpJobEventsError } from "../dist/mcp-job-events.js";
import { ensureMasterKey } from "../dist/crypto.js";
import { StateStore } from "../dist/store.js";

function fixture(status) {
  const dirPromise = mkdtemp(join(tmpdir(), "rotoxy-mcp-events-"));
  let state = { version: 1, mcpJobEvents: { subscriptions: [], outbox: [], receipts: [] } };
  return dirPromise.then(async (dir) => {
    await ensureMasterKey(join(dir, "master.key"));
    const store = { keyPath: join(dir, "master.key"), async load() { return structuredClone(state); }, async update(fn) { const next = structuredClone(state); await fn(next); state = next; return structuredClone(state); } };
    return { dir, store, state: () => structuredClone(state), close: () => rm(dir, { recursive: true, force: true }), status };
  });
}
function secret() { return `whsec_${randomBytes(32).toString("base64")}`; }
function subscribeArgs(key, extra = {}) {
  return { name: "rotoxy.job.changed", arguments: { projectId: "project-a", jobId: "job-a" }, delivery: { mode: "webhook", url: "https://hooks.example.test/mcp-events/abc?x=1", secret: key }, ...extra };
}
function verifySignature(request, key) {
  const headers = new Headers(request.init.headers);
  const expected = createHmac("sha256", Buffer.from(key.slice(6), "base64"))
    .update(`${headers.get("webhook-id")}.${headers.get("webhook-timestamp")}.${request.init.body}`).digest("base64");
  assert.equal(headers.get("webhook-signature"), `v1,${expected}`);
  assert.equal(headers.get("x-mcp-subscription-id"), request.subscriptionId);
}

test('real StateStore restart retains encrypted subscription and pending event identity',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'rotoxy-events-disk-'));
  const old=process.env.ROTOXY_CONFIG_DIR;process.env.ROTOXY_CONFIG_DIR=dir;
  const store=new StateStore();
  if(old===undefined)delete process.env.ROTOXY_CONFIG_DIR;else process.env.ROTOXY_CONFIG_DIR=old;
  t.after(()=>rm(dir,{recursive:true,force:true}));
  await store.init({adminPassword:'synthetic-events-disk-password'});
  let now=Date.now();const key=secret();
  const row={projectId:'project-a',assignmentId:'job-a',state:'running',revision:1};
  const posts=[];
  const transport=async(_url,init)=>{
    const body=JSON.parse(init.body);
    if(body.type==='verification')return Response.json({challenge:body.challenge});
    posts.push(body.eventId);return new Response(null,{status:posts.length===1?503:204});
  };
  const service=new McpJobEvents({store,now:()=>now,getStatus:async()=>row,webhookFetch:transport});
  await service.call('events/subscribe',subscribeArgs(key),'client-a');
  row.state='complete';row.revision++;await service.tick();
  const pending=(await store.load()).mcpJobEvents.outbox[0].eventId;
  const raw=await readFile(store.statePath,'utf8');assert.equal(raw.includes(key),false);
  assert.equal((await stat(store.statePath)).mode&0o777,0o600);
  process.env.ROTOXY_CONFIG_DIR=dir;
  const reopened=new StateStore();
  if(old===undefined)delete process.env.ROTOXY_CONFIG_DIR;else process.env.ROTOXY_CONFIG_DIR=old;
  now+=2000;
  await new McpJobEvents({store:reopened,now:()=>now,getStatus:async()=>row,webhookFetch:transport}).tick();
  assert.deepEqual(posts,[pending,pending]);
  const after=await reopened.load();
  assert.equal(after.mcpJobEvents.outbox.length,0);
  assert.equal(after.mcpJobEvents.receipts.at(-1).state,'accepted');
});

test("events/list exposes one metadata-only durable job event", async (t) => {
  const f = await fixture(); t.after(f.close);
  const events = new McpJobEvents({ store: f.store, getStatus: async () => ({}) });
  const result = await events.call("events/list", {}, "client-a");
  assert.deepEqual(result.events.map((event) => event.name), ["rotoxy.job.changed"]);
  assert.deepEqual(result.events[0].delivery, ["webhook"]);
  assert.equal(result.events[0].inputSchema.additionalProperties, false);
});

test('a job completed before subscription produces one catch-up event, not a missed completion',async t=>{
  const f=await fixture();t.after(f.close);let deliveries=0;
  const events=new McpJobEvents({store:f.store,getStatus:async()=>({projectId:'project-a',assignmentId:'job-a',state:'complete',revision:2}),webhookFetch:async(_url,init)=>{
    const body=JSON.parse(init.body);if(body.type==='verification')return Response.json({challenge:body.challenge});
    assert.equal(body.data.state,'complete');deliveries++;return new Response(null,{status:204});
  }});
  const args=subscribeArgs(secret());await events.call('events/subscribe',args,'client-a');
  await events.tick();assert.equal(deliveries,1);
  await events.call('events/subscribe',args,'client-a');await events.tick();
  assert.equal(deliveries,1,'refresh does not replay the catch-up event');
});

test("admin token revocation invalidates persisted event subscriptions after restart", async t=>{
  const f=await fixture();t.after(f.close);
  const status={projectId:'project-a',assignmentId:'job-a',state:'queued',revision:1};
  let deliveries=0;
  const options={store:f.store,getStatus:async()=>status,webhookFetch:async(_url,init)=>{
    const body=JSON.parse(init.body);
    if(body.type==='verification')return Response.json({challenge:body.challenge});
    deliveries++;return new Response(null,{status:503});
  }};
  const events=new McpJobEvents(options);
  await events.call('events/subscribe',subscribeArgs(secret()),'client-a');
  status.state='complete';status.revision++;await events.tick();
  assert.equal(deliveries,1);
  await f.store.update(raw=>{raw.security={accessTokenNotBefore:Math.floor(Date.now()/1000)};});
  await new McpJobEvents(options).tick();
  assert.equal(deliveries,1,'revoked callbacks receive no further events');
  assert.equal(f.state().mcpJobEvents.subscriptions.length,0);
  assert.equal(f.state().mcpJobEvents.outbox.length,0);
  assert.equal(f.state().mcpJobEvents.receipts.at(-1).state,'revoked');
});

test("subscribe verifies signed challenge, encrypts secret, and delivery signs exact persisted bytes", async (t) => {
  const status = { assignmentId: "job-a", projectId: "project-a", state: "running", revision: 1, prompt: "must-not-leak", output: "private output", tasks: [{ taskId: "task-a", state: "running", modelRequested: "oracle/qwen3.5:2b", modelReported: "oracle/qwen3.5:2b", selectedAccountId: "acct-a", instructions: "private", text: "private" }] };
  const f = await fixture(status); t.after(f.close);
  const key = secret(); const requests = []; const owners = [];
  const events = new McpJobEvents({ store: f.store, getStatus: async (args, clientId) => { owners.push({ args, clientId }); return status; },
    webhookFetch: async (url, init) => {
      const request = { url, init, subscriptionId: new Headers(init.headers).get("x-mcp-subscription-id") };
      requests.push(request); verifySignature(request, key);
      const body = JSON.parse(init.body);
      if (body.type === "verification") return Response.json({ challenge: body.challenge });
      return new Response(null, { status: 204 });
    } });
  const result = await events.call("events/subscribe", subscribeArgs(key, { ttlMs: null }), "client-a");
  assert.match(result.id, /^sub_[a-f0-9]{64}$/);
  assert.equal(result.cursor, null); assert.equal(result.truncated, false);
  assert.ok(Date.parse(result.refreshBefore) > Date.now());
  assert.equal(requests.length, 1);
  assert.equal(JSON.parse(requests[0].init.body).type, "verification");
  assert.equal(owners.length, 1);
  assert.equal(f.state().mcpJobEvents.subscriptions[0].secret.data.includes(key), false);

  status.state = "complete"; status.revision++;
  await events.tick();
  const delivered = requests.find((request) => JSON.parse(request.init.body).eventId?.startsWith("evt_"));
  assert.ok(delivered);
  verifySignature(delivered, key);
  const event = JSON.parse(delivered.init.body);
  assert.equal(event.name, "rotoxy.job.changed");
  assert.equal(event.data.state, "complete");
  assert.equal(event.data.tasks[0].modelRequested, "oracle/qwen3.5:2b");
  assert.equal(event.data.tasks[0].modelReported, "oracle/qwen3.5:2b");
  assert.equal(event.data.tasks[0].selectedAccountId, "acct-a");
  assert.doesNotMatch(delivered.init.body, /must-not-leak|private output|instructions|"text"/);
  assert.ok(owners.length >= 3, "status is authorized before subscribe, change detection, and delivery");
  assert.equal(f.state().mcpJobEvents.outbox.length, 0);
  assert.equal(f.state().mcpJobEvents.receipts[0].state, "accepted");
});

test("refresh identity is canonical, callback secret shape and TTL are bounded, and unsubscribe is idempotent", async (t) => {
  let now = 1_800_000_000_000;
  const status = { assignmentId: "job-a", projectId: "project-a", state: "running", revision: 1, tasks: [] };
  const f = await fixture(status); t.after(f.close);
  let verifications = 0;
  let deliveryStatus = 503;
  const events = new McpJobEvents({ store: f.store, now: () => now, getStatus: async () => status,
    webhookFetch: async (_url, init) => { verifications++; const body = JSON.parse(init.body); return body.type === "verification" ? Response.json({ challenge: body.challenge }) : new Response(null, { status: deliveryStatus }); } });
  const key = secret();
  const original = subscribeArgs(key);
  const first = await events.call("events/subscribe", original, "client-a");
  const reordered = subscribeArgs(key);
  reordered.arguments = { jobId: "job-a", projectId: "project-a" };
  const refreshed = await events.call("events/subscribe", reordered, "client-a");
  assert.equal(refreshed.id, first.id);
  assert.equal(f.state().mcpJobEvents.subscriptions.length, 1);
  assert.equal(verifications, 1, "successful callback verification is briefly cached per key");
  for (const invalid of ["whsec_abc", "whsec_" + Buffer.alloc(65).toString("base64")]) await assert.rejects(events.call("events/subscribe", subscribeArgs(invalid), "client-a"), McpJobEventsError);
  await assert.rejects(events.call("events/subscribe", subscribeArgs(key, { ttlMs: 86_400_001 }), "client-a"), /24 hours/);
  status.state = "complete"; status.revision++;
  await events.tick();
  const beforeRefresh = f.state().mcpJobEvents;
  assert.equal(beforeRefresh.outbox.length, 1);
  const savedFingerprint = beforeRefresh.subscriptions[0].lastFingerprint;
  const pendingEventId = beforeRefresh.outbox[0].eventId;
  await events.call("events/subscribe", reordered, "client-a");
  const afterRefresh = f.state().mcpJobEvents;
  assert.equal(afterRefresh.subscriptions[0].lastFingerprint, savedFingerprint, "refresh preserves observation baseline");
  assert.equal(afterRefresh.outbox[0].eventId, pendingEventId, "refresh preserves pending delivery");
  assert.ok(verifications >= 2, "delivery and callback verification requests are observed");
  assert.deepEqual(await events.call("events/unsubscribe", { name: "rotoxy.job.changed", arguments: original.arguments, delivery: { mode: "webhook", url: original.delivery.url } }, "client-a"), {});
  await events.call("events/unsubscribe", { name: "rotoxy.job.changed", arguments: original.arguments, delivery: { mode: "webhook", url: original.delivery.url } }, "client-a");
  assert.equal(f.state().mcpJobEvents.subscriptions.length, 0);
  assert.equal(f.state().mcpJobEvents.receipts.find((receipt) => receipt.eventId === pendingEventId).state, "revoked");
  now += 2000; const beforeUnsubscribedTick = verifications; await events.tick();
  assert.equal(verifications, beforeUnsubscribedTick, "unsubscribe prevents later delivery attempts");
});

test("webhook retry preserves event ID, refreshes signature timestamp, and stops on authorization loss", async (t) => {
  let now = 1_800_000_000_000;
  const status = { projectId: "project-a", jobId: "job-a", state: "queued", revision: 1, tasks: [] };
  const f = await fixture(status); t.after(f.close);
  const key = secret(); const requests = []; let postCount = 0; let authorized = true;
  const events = new McpJobEvents({ store: f.store, now: () => now, getStatus: async () => { if (!authorized) throw new McpJobEventsError(-32001, "Job unavailable"); return status; },
    webhookFetch: async (_url, init) => {
      const request = { init, subscriptionId: new Headers(init.headers).get("x-mcp-subscription-id") };
      requests.push(request);
      const body = JSON.parse(init.body);
      if (body.type === "verification") return Response.json({ challenge: body.challenge });
      postCount++; return new Response(null, { status: postCount === 1 ? 503 : 204 });
    } });
  await events.call("events/subscribe", subscribeArgs(key), "client-a");
  status.state = "running"; status.revision++;
  await events.tick();
  const firstDelivery = requests.at(-1);
  assert.equal(f.state().mcpJobEvents.outbox.length, 1);
  assert.equal(f.state().mcpJobEvents.receipts[0].state, "retry_due");
  assert.equal(f.state().mcpJobEvents.receipts[0].httpStatus, 503);
  now += 1500;
  await events.tick();
  const retry = requests.at(-1);
  assert.equal(JSON.parse(retry.init.body).eventId, JSON.parse(firstDelivery.init.body).eventId);
  assert.notEqual(new Headers(retry.init.headers).get("webhook-timestamp"), new Headers(firstDelivery.init.headers).get("webhook-timestamp"));
  assert.equal(f.state().mcpJobEvents.outbox.length, 0);
  assert.equal(f.state().mcpJobEvents.receipts[0].state, "accepted");
  status.state = "complete"; status.revision++; await events.tick();
  authorized = false; const before = requests.length; now += 1000; await events.tick();
  assert.equal(requests.length, before, "authorization loss stops event delivery");
  assert.equal(f.state().mcpJobEvents.subscriptions.length, 0);
});

test("transient status failure pauses delivery without revoking a subscription", async (t) => {
  const status = { assignmentId: "job-a", projectId: "project-a", state: "queued", revision: 1, tasks: [] };
  const f = await fixture(status); t.after(f.close);
  const key = secret(); let fail = false; let posts = 0;
  const events = new McpJobEvents({ store: f.store, getStatus: async () => { if (fail) throw new Error("upstream timeout with private data"); return status; },
    webhookFetch: async (_url, init) => { const body = JSON.parse(init.body); if (body.type === "verification") return Response.json({ challenge: body.challenge }); posts++; return new Response(null, { status: 204 }); } });
  await events.call("events/subscribe", subscribeArgs(key), "client-a");
  status.state = "running"; status.revision++; fail = true; await events.tick();
  assert.equal(f.state().mcpJobEvents.subscriptions.length, 1);
  assert.equal(f.state().mcpJobEvents.outbox.length, 0, "no application event is queued from an unavailable status read");
  assert.equal(posts, 0);
  fail = false; await events.tick();
  assert.equal(posts, 1);
  assert.equal(f.state().mcpJobEvents.subscriptions.length, 1);
});

test("rotates the eight-subscription work window so later subscriptions are not starved", async (t) => {
  const states = new Map(Array.from({ length: 10 }, (_, index) => [`job-${index}`, { assignmentId: `job-${index}`, projectId: "project-a", state: "queued", revision: 1, tasks: [] }]));
  const f = await fixture(); t.after(f.close);
  let deliveries = 0; const key = secret();
  const events = new McpJobEvents({ store: f.store, getStatus: async ({ jobId }) => states.get(jobId),
    webhookFetch: async (_url, init) => { const body = JSON.parse(init.body); if (body.type === "verification") return Response.json({ challenge: body.challenge }); deliveries++; return new Response(null, { status: 204 }); } });
  for (let index = 0; index < 10; index++) await events.call("events/subscribe", { name: "rotoxy.job.changed", arguments: { projectId: "project-a", jobId: `job-${index}` }, delivery: { mode: "webhook", url: "https://hooks.example.test/callback", secret: key } }, "client-a");
  for (const row of states.values()) { row.state = "running"; row.revision++; }
  await events.tick(); assert.equal(deliveries, 8);
  await events.tick(); assert.equal(deliveries, 10);
  assert.equal(f.state().mcpJobEvents.subscriptions.length, 10);
});

test("secret refresh preserves queued events and signs with both keys during rotation", async (t) => {
  let now = 1_800_000_000_000;
  const status = { assignmentId: "job-a", projectId: "project-a", state: "queued", revision: 1, tasks: [] };
  const f = await fixture(); t.after(f.close);
  const oldKey = secret(); const newKey = secret(); const requests = []; let eventPosts = 0;
  const events = new McpJobEvents({ store: f.store, now: () => now, getStatus: async () => status,
    webhookFetch: async (_url, init) => {
      requests.push(init); const body = JSON.parse(init.body);
      if (body.type === "verification") return Response.json({ challenge: body.challenge });
      eventPosts++; return new Response(null, { status: eventPosts === 1 ? 503 : 204 });
    } });
  const args = subscribeArgs(oldKey);
  await events.call("events/subscribe", args, "client-a");
  status.state = "running"; status.revision++; await events.tick();
  const pendingId = f.state().mcpJobEvents.outbox[0].eventId;
  await events.call("events/subscribe", subscribeArgs(newKey), "client-a");
  assert.equal(f.state().mcpJobEvents.outbox[0].eventId, pendingId);
  assert.ok(f.state().mcpJobEvents.subscriptions[0].previousSecret);
  now += 1500; await events.tick();
  const retry = requests.at(-1); const headers = new Headers(retry.headers);
  const parts = headers.get("webhook-signature").split(" ");
  const body = retry.body; const eventId = headers.get("webhook-id"); const timestamp = headers.get("webhook-timestamp");
  const expected = [newKey, oldKey].map((value) => `v1,${createHmac("sha256", Buffer.from(value.slice(6), "base64")).update(`${eventId}.${timestamp}.${body}`).digest("base64")}`);
  assert.deepEqual(parts.sort(), expected.sort());
  assert.equal(f.state().mcpJobEvents.outbox.length, 0);
});

test("limits concurrent callback challenges and rejects unknown job identity before activation", async (t) => {
  const f = await fixture(); t.after(f.close);
  const pending = []; const key = secret();
  const events = new McpJobEvents({ store: f.store, getStatus: async ({ jobId }) => ({ projectId: "project-a", assignmentId: jobId, state: "queued" }),
    webhookFetch: async (_url, init) => new Promise((resolve) => pending.push(() => resolve(Response.json({ challenge: JSON.parse(init.body).challenge })))) });
  const calls = Array.from({ length: 5 }, (_, index) => events.call("events/subscribe", { name: "rotoxy.job.changed", arguments: { projectId: "project-a", jobId: `job-${index}` }, delivery: { mode: "webhook", url: `https://hooks${index}.example.test/callback`, secret: key } }, "client-a"));
  for (const pendingCall of calls) void pendingCall.catch(() => undefined);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(pending.length, 4);
  await assert.rejects(calls[4], (error) => error instanceof McpJobEventsError && error.code === -32015 && error.reason === "capacity");
  for (const finish of pending) finish();
  const results = await Promise.all(calls.slice(0, 4));
  assert.equal(results.length, 4);
  assert.equal(f.state().mcpJobEvents.subscriptions.length, 4);

  const wrong = new McpJobEvents({ store: f.store, getStatus: async () => ({ projectId: "project-a", assignmentId: "some-other-job", state: "queued" }), webhookFetch: async () => { assert.fail("identity mismatch must fail before callback verification"); } });
  await assert.rejects(wrong.call("events/subscribe", subscribeArgs(key), "client-a"), (error) => error instanceof McpJobEventsError && error.code === -32001);
});
