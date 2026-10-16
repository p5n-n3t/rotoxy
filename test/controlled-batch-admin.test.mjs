import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { StateStore } from "../dist/store.js";
import { AdminSessions, adminEpoch } from "../dist/admin-session.js";
import { createControlledBatchAdminRouter } from "../dist/controlled-batch-admin.js";

const op = { bindingHash: "a".repeat(64), assignmentId: "batch-a", operationId: "operation-a", taskId: "task-a", attemptId: "attempt-a", generation: 1, accountId: "account-a", kind: "chat_session", state: "rejected", reason: "credit_denied", model: "model-a", createdAt: 10, taskState: "blocked" };
const expired = { approvalId: "grant-a", assignmentId: "batch-a", operationIds: ["operation-a"], accountIds: ["account-a"], maxLaunches: 1, consumed: 1, expiresAt: 1, expired: true, acknowledgedUnknownCost: true };

test("approval admin uses trusted bridge paths, admin session, origin, CSRF and exact bindings", async t => {
  const root = await mkdtemp(join(tmpdir(), "t2o-controlled-admin-"));
  const oldHome = process.env.HOME, oldConfig = process.env.TOKEN2OAUTH_CONFIG_DIR;
  process.env.HOME = join(root, "home"); process.env.TOKEN2OAUTH_CONFIG_DIR = join(root, "config");
  const store = new StateStore(); await store.init({ adminPassword: "synthetic-admin-password", publicBaseUrl: "http://127.0.0.1:2030/token2oauth" });
  const sessions = new AdminSessions(), session = sessions.create(60000, adminEpoch(await store.load())), csrf = sessions.csrfToken(session);
  const calls = [];
  let stale = false;
  const stateDir = join(root, "trusted-supervisor-state");
  const admin = createControlledBatchAdminRouter(store, sessions, { stateDir, supervisorCwd: join(root, "supervisor"), commandRunner: async (command,args,request,input) => {
    calls.push({command,args,request,input:JSON.parse(input)});
    assert.equal(command,"/usr/bin/python3"); assert.deepEqual(args,["-m","snooze.controlled_batch_admin","--state-dir",stateDir]);
    if(calls.at(-1).input.action==="read") return JSON.stringify({operations:stale?[]:[op],grants:[expired]});
    return JSON.stringify({approvalId:"grant-new"});
  }});
  const app=express(); app.use("/token2oauth",admin.router); const server=createServer(app);
  await new Promise((resolve,reject)=>{server.once("error",reject);server.listen(0,"127.0.0.1",resolve);});
  const base=`http://127.0.0.1:${server.address().port}/token2oauth`, cookie=`t2o_admin=${encodeURIComponent(session)}`;
  const post=(fields,origin=`http://127.0.0.1:2030`)=>fetch(`${base}/admin/dispatch-approvals`,{method:"POST",redirect:"manual",headers:{cookie,origin,"content-type":"application/x-www-form-urlencoded"},body:new URLSearchParams(fields)});
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));await rm(root,{recursive:true,force:true});if(oldHome===undefined)delete process.env.HOME;else process.env.HOME=oldHome;if(oldConfig===undefined)delete process.env.TOKEN2OAUTH_CONFIG_DIR;else process.env.TOKEN2OAUTH_CONFIG_DIR=oldConfig;});
  assert.equal((await fetch(`${base}/admin/dispatch-approvals`,{redirect:"manual"})).status,302);
  const view=await fetch(`${base}/admin/dispatch-approvals`,{headers:{cookie}}); assert.equal(view.status,200); const html=await view.text();
  assert.match(html,/Expired/); assert.match(html,/no hard monetary ceiling/i); assert.match(html,/does not resume a paused project/i); assert.doesNotMatch(html,/PRIVATE prompt|instructions|synthetic-token/i);
  const fields={assignmentId:"batch-a",operationId:"operation-a",maxLaunches:"1",ttlSeconds:"120",ackUnknownCreditCost:"1","binding.operation-a":"a".repeat(64),_csrf:csrf};
  assert.equal((await post(fields,"https://attacker.example")).status,403);
  assert.equal((await post({...fields,_csrf:"bad"})).status,403);
  assert.equal((await post({...fields,ackUnknownCreditCost:undefined})).status,400);
  assert.equal((await post({...fields,maxLaunches:"2"})).status,400);
  assert.equal((await post({...fields,"binding.operation-a":"b".repeat(64)})).status,409);
  stale=true; assert.equal((await post(fields)).status,409); stale=false;
  const approved=await post(fields); assert.equal(approved.status,303);
  const approveCall=calls.find(c=>c.input.action==="approve"); assert.deepEqual(approveCall.input.approval.expectedBindings,{"operation-a":"a".repeat(64)});
  assert.deepEqual(approveCall.input.approval.accountIds,["account-a"]);
});
