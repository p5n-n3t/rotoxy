import test from "node:test";
import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { pkceS256 } from "../dist/crypto.js";
import { StateStore } from "../dist/store.js";
import { buildApp } from "../dist/server.js";
import { JobInputError } from "../dist/job-submit.js";
const ADMIN="correct-horse-battery-staple";
const listen = (server) => new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => resolve(server.address()));
});
const close = (server) => new Promise((resolve) => server.close(resolve));

async function oauthToken(base, scope) {
  const registration = await (await fetch(base + "/oauth/register", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "job-test", redirect_uris: [base + "/callback"] }),
  })).json();
  const verifier = "v".repeat(64);
  const consent = await fetch(base + "/oauth/authorize", {
    method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: registration.client_id, redirect_uri: base + "/callback", response_type: "code", code_challenge: pkceS256(verifier), code_challenge_method: "S256", resource: base + "/mcp", scope, admin_password: ADMIN }),
  });
  const location = consent.headers.get("location");
  if (!location) throw new Error(`OAuth consent failed (${consent.status}): ${await consent.text()}`);
  const code = new URL(location).searchParams.get("code");
  const token = await (await fetch(base + "/oauth/token", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", client_id: registration.client_id, redirect_uri: base + "/callback", code, code_verifier: verifier, resource: base + "/mcp" }),
  })).json();
  return { token: token.access_token, clientId: registration.client_id };
}

function mcp(base, token, message) {
  return fetch(base + "/mcp", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(message) });
}


test("OAuth clients collaborate through one MCP, preserving project, actor, claim and review boundaries", async()=>{
 const dir=await mkdtemp(join(tmpdir(),"rx-workspace-mcp-"));
 const previous=process.env.ROTOXY_CONFIG_DIR;process.env.ROTOXY_CONFIG_DIR=dir;
 let gateway;
 try {
  const store=new StateStore();await store.init({adminPassword:ADMIN});
  const allowed=new Set();
  const backend={listProjects:()=>["project-1"],callTool:async()=>({}),readAdmin:async()=>({jobs:[],workers:[]}),
   authorizeWorkspace:(project,client)=>{if(project!=="project-1"||!allowed.has(client))throw new JobInputError("project is not authorized");}};
  const built=await buildApp(store,{supervisorBackend:backend});gateway=createHttpServer(built.app);
  const address=await listen(gateway),base="http://127.0.0.1:"+address.port;
  await store.update(s=>{s.config.publicBaseUrl=base;s.config.basePath="";s.config.upstreamUrl="";});
  const a=await oauthToken(base,"mcp jobs:read jobs:write"),b=await oauthToken(base,"mcp jobs:read jobs:write"),ro=await oauthToken(base,"mcp jobs:read");
  for(const x of [a,b,ro])allowed.add(x.clientId);
  const call=async(who,name,args)=>{
   const r=await mcp(base,who.token,{jsonrpc:"2.0",id:randomUUID(),method:"tools/call",params:{name,arguments:args}});
   const body=await r.json();return {status:r.status,body,value:body.result?.content?.[0]?.text?JSON.parse(body.result.content[0].text):undefined};
  };
  const snapshot=async who=>{const r=await call(who,"workspace_snapshot",{projectId:"project-1"});assert.equal(r.status,200,JSON.stringify(r.body));return r.value;};
  const mutate=async(who,input)=>{const s=await snapshot(who);return call(who,"workspace_update",{projectId:"project-1",input:{idempotencyKey:randomUUID(),expectedRevision:s.revision,...input}});};
  const listing=await mcp(base,a.token,{jsonrpc:"2.0",id:1,method:"tools/list"});
  assert.ok((await listing.json()).result.tools.some(x=>x.name==="workspace_update"));
  assert.equal((await mutate(ro,{action:"participant_upsert",label:"read-only",provider:"chatgpt"})).status,403);
  const denied=await call(a,"workspace_snapshot",{projectId:"other-project"});assert.ok(denied.body.error);
  assert.ok((await call(a,"workspace_snapshot",{projectId:"project-1",actor:"admin:local"})).body.error);
  for(const [who,label,provider] of [[a,"Parent","chatgpt"],[b,"Worker","claude-code"]]){
   const r=await mutate(who,{action:"participant_upsert",label,provider});assert.equal(r.status,200,JSON.stringify(r.body));
  }
  let r=await mutate(a,{action:"task_create",taskId:"task-1",title:"Review contract",description:"Return an artifact for peer review"});
  assert.equal(r.status,200,JSON.stringify(r.body));
  r=await mutate(b,{action:"task_claim",taskId:"task-1"});assert.equal(r.status,200,JSON.stringify(r.body));
  r=await mutate(a,{action:"task_claim",taskId:"task-1"});assert.ok(r.body.error);
  r=await mutate(b,{action:"message_send",messageId:"msg-1",to:"client:"+a.clientId,taskId:"task-1",text:"Ready for review"});
  assert.equal(r.status,200,JSON.stringify(r.body));
  r=await mutate(b,{action:"artifact_submit",artifactId:"artifact-1",taskId:"task-1",kind:"text",reference:"Verified result",title:"Contract review"});
  assert.equal(r.status,200,JSON.stringify(r.body));
  r=await mutate(b,{action:"review_decide",artifactId:"artifact-1",decision:"approved",note:"self"});
  assert.ok(r.body.error,"assignee cannot approve own work");
  r=await mutate(a,{action:"review_decide",artifactId:"artifact-1",decision:"approved",note:"Reviewed"});
  assert.equal(r.status,200,JSON.stringify(r.body));
  const final=await snapshot(a);assert.equal(final.tasks.find(t=>t.id==="task-1").state,"complete");
  assert.equal(final.tasks.find(t=>t.id==="task-1").assignee,"client:"+b.clientId);
  assert.ok(final.messages.some(m=>m.id==="msg-1"));
 } finally {
  if(gateway)await close(gateway);
  if(previous===undefined)delete process.env.ROTOXY_CONFIG_DIR;else process.env.ROTOXY_CONFIG_DIR=previous;
  await rm(dir,{recursive:true,force:true});
 }
});
