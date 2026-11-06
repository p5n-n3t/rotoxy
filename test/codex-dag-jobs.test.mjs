import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {StateStore} from '../dist/store.js';
import {CodexDagJobs,CompositeAgentJobs} from '../dist/codex-dag-jobs.js';
import {CodexPoolPolicyStore} from '../dist/codex-pool-policy.js';
import {OriginProtectionStore} from '../dist/origin-protection.js';

const targetProfile='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const nativeProfile='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const clientId='client-a';
const originSessionId='native-session-01';
const accountId='codex:'+targetProfile;
const model='gpt-5.6-luna';
const effort='medium';
const marker='DONE';
const op={operationId:'operation-codex-1234567890',kind:'run_agent',selectedAccountId:accountId,input:{provider:'codex',projectId:'fleet',clientId,jobId:'job-one',taskId:'task-one',profileId:targetProfile,model,reasoningEffort:effort,complexity:'routine',originSessionId,prompt:'Return one bounded result.\nDONE',expectedMarker:marker,timeoutMs:10000}};

async function fixture(t,{bound=true,nativeSubject='native-account-subject',targetSubject='target-account-subject',dispatchEnabled=true,workspaceFailure=false}={}){
 const dir=await mkdtemp(join(tmpdir(),'rx-codex-dag-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const oldDir=process.env.ROTOXY_CONFIG_DIR;process.env.ROTOXY_CONFIG_DIR=dir;t.after(()=>{if(oldDir===undefined)delete process.env.ROTOXY_CONFIG_DIR;else process.env.ROTOXY_CONFIG_DIR=oldDir;});
 const store=new StateStore();await store.init({adminPassword:'test-only-password'});
 await writeFile(join(dir,'codex-profiles.json'),JSON.stringify({version:1,profiles:[{id:nativeProfile},{id:targetProfile}]}),{mode:0o600});
 const policy=new CodexPoolPolicyStore(store);
 await policy.configure({version:1,dispatchEnabled,protectInitiatingAccount:true,profiles:[{profileId:nativeProfile,enabled:false,maxConcurrent:1},{profileId:targetProfile,enabled:true,maxConcurrent:1}]});
 if(bound){
  const origins=new OriginProtectionStore(store,()=>Date.now());
  await origins.bindOrRenew({actor:{clientId,sessionId:originSessionId},nativeProfileId:nativeProfile,profileAliases:[nativeProfile],verifiedProviderAccountSubject:nativeSubject,source:'trusted-server-resolver',expectedRevision:0,expiresAt:Date.now()+60_000});
 }
 const snapshot={profileId:targetProfile,capturedAt:Date.now(),authMode:'chatgpt',accountIdentity:targetSubject,planType:'plus',models:[{id:model,reasoningEfforts:[effort,'high']}],rateWindows:[{limitId:'weekly',slot:'week',usedPercent:10,exhausted:false}]};
 let launches=0,cancelled=0;
 let taskState;
 const workspace={async snapshot(project,actor){assert.equal(project,'fleet');assert.match(actor,/^client:(client-a|codex-worker-[a-f0-9]+)$/);if(workspaceFailure)throw Error('workspace unavailable');return {revision:taskState?.revision??0,participants:[{id:actor}],tasks:taskState?[taskState]:[],artifacts:taskState?.artifact?[{id:taskState.artifact,taskId:taskState.id}]:[]};},async update(project,actor,input){
  if(input.action==='task_create')taskState={id:input.taskId,revision:1,state:'ready',description:input.description};
  else if(input.action==='task_claim')taskState={...taskState,revision:taskState.revision+1,state:'claimed'};
  else if(input.action==='artifact_submit')taskState={...taskState,revision:taskState.revision+1,artifact:input.artifactId};
  else if(input.action==='task_update')taskState={...taskState,revision:taskState.revision+1,state:input.state};
  else throw Error('unexpected workspace operation '+input.action);
 }};
 const profiles={async listProfiles(){return [{id:targetProfile}];},async refreshProfile(id){assert.equal(id,targetProfile);return structuredClone(snapshot);},startExecution(request){launches++;let rejectPromise;let resolvePromise;const promise=new Promise((resolve,reject)=>{resolvePromise=resolve;rejectPromise=reject;});request.onReceipt({threadId:'thread-codex-01',turnId:'turn-codex-01'});const handle={promise,pendingRequests:[],async cancel(){cancelled++;rejectPromise(Error('cancelled'));}};if(!fixture.waitForExecution)resolvePromise({profileId:targetProfile,threadId:'thread-codex-01',turnId:'turn-codex-01',modelId:model,reasoningEffort:effort,text:'Bounded result\nDONE',status:'completed'});return handle;}};
 const adapter=new CodexDagJobs(store,profiles,workspace,dir);
 return {dir,store,policy,workspace,profiles,adapter,counts:()=>({launches,cancelled}),setWait(value){fixture.waitForExecution=value;}};
}

test('unknown or protected origin account cannot launch Codex execution',async t=>{
 const unknown=await fixture(t,{bound:false});
 assert.equal((await unknown.adapter.invoke(op)).classification,'rejected');assert.equal(unknown.counts().launches,0);
 const protectedAccount=await fixture(t,{nativeSubject:'same-provider-account',targetSubject:'same-provider-account'});
 assert.equal((await protectedAccount.adapter.invoke(op)).classification,'rejected');assert.equal(protectedAccount.counts().launches,0);
});

test('successful run persists result receipt and workspace artifact; repeated operation never launches again',async t=>{
 const f=await fixture(t);const first=await f.adapter.invoke(op);assert.equal(first.classification,'accepted');
 assert.equal(first.value.threadId,'thread-codex-01');assert.equal(first.value.turnId,'turn-codex-01');
 const state=await f.store.load();const attempt=state.codexDagAttempts[op.operationId];
 assert.equal(attempt.status,'success');assert.equal(attempt.result.artifactId,first.value.artifactId);
 assert.equal(attempt.threadId,'thread-codex-01');assert.equal(attempt.turnId,'turn-codex-01');
 const replay=await f.adapter.invoke(op);assert.equal(replay.classification,'accepted');assert.equal(replay.value.artifactId,first.value.artifactId);
 assert.deepEqual(f.counts(),{launches:1,cancelled:0});
});

test('restored ambiguous attempt is reconciled without launching a replacement',async t=>{
 const first=await fixture(t,{workspaceFailure:true});
 assert.equal((await first.adapter.invoke(op)).classification,'ambiguous');
 assert.equal((await first.store.load()).codexDagAttempts[op.operationId].status,'ambiguous');
 const restored=new CodexDagJobs(first.store,first.profiles,first.workspace,first.dir);
 assert.equal((await restored.invoke(op)).classification,'ambiguous');
 assert.equal(first.counts().launches,0);
});

test('cancelJob cancels only the owned pending handle; native approval requests fail closed',async t=>{
 const f=await fixture(t);f.setWait(true);
 const pending=f.adapter.invoke(op);
 for(let i=0;i<100&&f.counts().launches===0;i++)await new Promise(r=>setTimeout(r,5));
 assert.equal(f.counts().launches,1);
 assert.equal(await f.adapter.cancelJob('fleet','other-job',clientId),0);
 assert.equal(f.counts().cancelled,0);
 assert.equal(await f.adapter.cancelJob('fleet','job-one',clientId),1);
 assert.equal((await pending).classification,'ambiguous');assert.equal(f.counts().cancelled,1);
 const approval=await fixture(t);let approveCancel=0;let rejectApproval;const approvalPromise=new Promise((_,reject)=>{rejectApproval=reject;});
 approval.profiles.startExecution=()=>({promise:approvalPromise,get pendingRequests(){return [{id:3,method:'item/commandExecution/requestApproval',params:{}}];},async cancel(){approveCancel++;rejectApproval(Error('approval denied'));}});
 const waiting=approval.adapter.invoke(op);
 for(let i=0;i<120&&approveCancel===0;i++)await new Promise(r=>setTimeout(r,10));
 assert.equal(approveCancel,1,'pending native approval is rejected by cancellation');
 assert.equal((await waiting).classification,'ambiguous');assert.equal(approval.counts().launches,0);
});

test('disabled pool and profile account identity aliases fail closed',async t=>{
 const disabled=await fixture(t,{dispatchEnabled:false});
 assert.deepEqual(await disabled.adapter.resources(),[]);
 assert.equal((await disabled.adapter.invoke(op)).classification,'rejected');assert.equal(disabled.counts().launches,0);
 const alias=await fixture(t,{nativeSubject:'target-account-subject',targetSubject:'target-account-subject'});
 assert.equal((await alias.adapter.invoke(op)).classification,'rejected');assert.equal(alias.counts().launches,0);
});

test('composite agent routing preserves Claude operations with no provider field',async()=>{
 const claude={accountId:'claude-code:local',provider:'claude-code',profileId:'local',models:['haiku'],capacity:1,timeoutMs:120000};
 let claudeCalls=0,codexCalls=0;
 const composite=new CompositeAgentJobs([
  {async resources(){return [{accountId:'codex:'+targetProfile,provider:'codex',profileId:targetProfile,models:[model],capacity:1,timeoutMs:120000,busy:false,reasoningEfforts:{[model]:[effort]}}];},async invoke(){codexCalls++;return {classification:'rejected',accountId:'codex:'+targetProfile};}},
  {async resources(){return [claude];},async invoke(operation){claudeCalls++;assert.equal(operation.input.provider,undefined);return {classification:'accepted',accountId:claude.accountId,value:{assistantText:'ok'}};}}
 ]);
 const legacyClaude={operationId:'claude-operation-1234567890',kind:'run_agent',selectedAccountId:claude.accountId,input:{projectId:'fleet',clientId,jobId:'job-old',taskId:'task-old',profileId:'local',model:'haiku',prompt:'old task',timeoutMs:10000}};
 assert.equal((await composite.invoke(legacyClaude)).classification,'accepted');assert.equal(claudeCalls,1);assert.equal(codexCalls,0);
});
