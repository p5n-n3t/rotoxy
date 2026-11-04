import test from 'node:test';
import assert from 'node:assert/strict';
import {ClaudeDagJobs} from '../dist/claude-dag-jobs.js';
import {validateJobSubmission} from '../dist/job-submit.js';
import {SupervisorRuntime} from '../dist/supervisor-runtime.js';
import {createJobWorker} from '../dist/job-worker.js';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const resource={accountId:'claude-code:local',provider:'claude-code',profileId:'local',models:['haiku-test'],capacity:1,timeoutMs:120000};
const op={operationId:'operation-1234567890',kind:'run_agent',selectedAccountId:resource.accountId,input:{projectId:'fleet',clientId:'client-a',jobId:'job-one',profileId:'local',model:'haiku-test',prompt:'Return a fact.\nDONE',expectedMarker:'DONE',timeoutMs:10000,taskId:'one'}};
function fixture({model='haiku-test',artifact=true,previous=false}={}){
 let launches=0;let created=0;let task;let state=previous?'success':'missing';
 const workspace={async snapshot(project,actor){assert.equal(project,'fleet');assert.equal(actor,'client:client-a');return {revision:1,participants:[{id:actor}],tasks:task?[task]:[],artifacts:state==='success'&&artifact?[{id:'claude-attempt-1-result',taskId:task?.id}]:[]};},async update(project,actor,input){assert.equal(input.action,'task_create');created++;task={id:input.taskId,description:input.description};}};
 const runtime={async resources(){return [resource];},async call(name,args,client){assert.equal(client,'client-a');if(name==='claude_task_submit'){launches++;state='success';return {accepted:true};}assert.equal(name,'claude_task_status');return state==='missing'?{found:false}:{found:true,status:state,attemptId:'claude-attempt-1',modelRequested:'haiku-test',modelReported:model,result:'Verified fact.\nDONE',costUsd:0.001};}};
 return {runtime,adapter:new ClaudeDagJobs(runtime,workspace,async()=>{}),counts:()=>({launches,created})};
}
test('cancellation before invoke or during profile discovery cannot launch a child',async()=>{
 const early=fixture();await early.adapter.cancelJob('fleet','job-one','client-a');
 assert.equal((await early.adapter.invoke(op)).classification,'rejected');assert.deepEqual(early.counts(),{launches:0,created:0});
 const delayed=fixture();let release;delayed.runtime.resources=()=>new Promise(r=>{release=()=>r([resource]);});
 const pending=delayed.adapter.invoke(op);await delayed.adapter.cancelJob('fleet','job-one','client-a');release();
 assert.equal((await pending).classification,'rejected');assert.deepEqual(delayed.counts(),{launches:0,created:0});
});
test('DAG adapter creates stable workspace task, retrieves verified result/artifact, and never relaunches receipt',async()=>{
 const f=fixture();const first=await f.adapter.invoke(op);assert.equal(first.classification,'accepted');assert.equal(first.value.artifactId,'claude-attempt-1-result');
 assert.equal((await f.adapter.invoke(op)).classification,'accepted');assert.deepEqual(f.counts(),{launches:1,created:1});
});
test('DAG adapter rejects cross-profile pin before creating task',async()=>{
 const f=fixture();assert.equal((await f.adapter.invoke({...op,selectedAccountId:'claude-code:other'})).classification,'rejected');assert.deepEqual(f.counts(),{launches:0,created:0});
});
test('claimed agent operations use the agent executor once, with no legacy account fallback',async()=>{
 let claimed=false,calls=0,posted;
 const bridge={async request(method,route,body){if(route.endsWith('/claim')){if(claimed)return null;claimed=true;return {...op,attemptId:'attempt-a',generation:1};}if(route.endsWith('/result')){posted=body;return {};}throw Error('unexpected route');}};
 const worker=createJobWorker({bridge,adapterFactory:()=>{throw Error('legacy fallback forbidden');},agentExecutor:{resources:async()=>[resource],invoke:async()=>{calls++;return {classification:'ambiguous',accountId:resource.accountId,reason:'lost_result'};}},isAgentEligible:async()=>true,isAccountEligible:async()=>false,workerId:'agent-test',allowedModels:[],pollIntervalMs:10});
 worker.start();try{for(let i=0;i<200&&!posted;i++)await new Promise(r=>setTimeout(r,5));assert.equal(posted?.outcome,'ambiguous');await worker.tick();assert.equal(calls,1);}finally{await worker.stop();}
});
test('provider success cannot override missing artifact or wrong reported model',async()=>{
 for(const options of [{model:'other'},{artifact:false}]){const f=fixture(options);assert.equal((await f.adapter.invoke(op)).classification,'ambiguous');assert.equal(f.counts().launches,1);}
});
function submission(){return {schemaVersion:1,jobId:'dag',idempotencyKey:'dag-idem',projectId:'fleet',eligibleAccountIds:[resource.accountId],tasks:[{taskId:'one',dependsOn:[],scopeKeys:['record:one'],instructions:'Check a fact',execution:{mode:'agent',provider:'claude-code',profileId:'local',model:'haiku-test',timeoutMs:10000},output:{kind:'text',maxBytes:1000,format:'text',expectedMarker:'DONE'}}]};}
test('public agent execution schema refuses launch authority and unsupported timeout',()=>{
 assert.equal(validateJobSubmission(submission()).tasks[0].execution.mode,'agent');
 for(const patch of [{binary:'/bin/sh'},{clientId:'victim'},{timeoutMs:120001},{provider:'inference'}]){const s=submission();Object.assign(s.tasks[0].execution,patch);assert.throws(()=>validateJobSubmission(s));}
});
test('runtime binds agent task to selected trusted profile without legacy upstream, rejecting unbound models/projects',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'rx-agent-dag-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const config={version:1,projects:[{projectId:'fleet',clientIds:['client-a'],accountIds:[resource.accountId],registeredSessions:[]}],maxWorkers:2,allowUnknownQuota:true,localLimits:{maxTasks:100,maxJobBytes:1048576,maxOutputBytes:32768}};
 const runtime=new SupervisorRuntime(config,{configDir:dir,routingConfigDir:dir,store:{load:async()=>({config:{},accounts:[]})},oracleInventoryReader:async()=>({hosts:[]})});runtime.started=true;
 runtime.setAgentExecutor({resources:async()=>[resource],invoke:async()=>{throw Error('must not execute during submit');}});
 let submitted;runtime.bridge={request:async(method,path,body,owner)=>{assert.equal(path,'/v1/assignments');assert.equal(owner.clientId,'client-a');submitted=body;return {assignmentId:'dag',state:'queued'};}};
 await runtime.callTool('job_submit',submission(),{clientId:'client-a',projectId:'fleet'});
 assert.equal(submitted.tasks[0].execution.accountId,resource.accountId);assert.equal(submitted.tasks[0].execution.mode,'agent');assert.ok(submitted.tasks[0].instructions.endsWith('DONE'));
 const bad=submission();bad.tasks[0].execution.model='not-allowed';await assert.rejects(runtime.callTool('job_submit',bad,{clientId:'client-a',projectId:'fleet'}),/not enabled/);
 await assert.rejects(runtime.callTool('job_submit',submission(),{clientId:'other',projectId:'fleet'}),/not authorized/);
 runtime.setAgentExecutor({resources:async()=>{throw Error('private registry unavailable');},invoke:async()=>{throw Error('must not launch');}});
 const inventory=await runtime.callTool('job_workers',{projectId:'fleet'},callerForInventory());
 assert.deepEqual(inventory.agentResources,[]);assert.match(inventory.agentResourcesStatus,/registry unavailable/);
});
function callerForInventory(){return {clientId:'client-a',projectId:'fleet'};}

test('new inference work prefers a free eligible account while retaining ambiguous occupancy',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'rx-capacity-route-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const config={version:1,projects:[{projectId:'fleet',clientIds:['client-a'],accountIds:['cf-held','_cf-free'],registeredSessions:[]}],maxWorkers:2,allowUnknownQuota:true,localLimits:{maxTasks:100,maxJobBytes:1048576,maxOutputBytes:32768}};
 const runtime=new SupervisorRuntime(config,{configDir:dir,store:{load:async()=>({config:{},accounts:[]})}});runtime.started=true;
 const model='@cf/meta/llama-3.1-8b-instruct';runtime.inferenceResources=async()=>new Map(['cf-held','_cf-free'].map(id=>[id,{provider:'cloudflare',enabled:true,authorized:true,health:'healthy',capacity:1,models:[model],maxOutputTokens:128}]));
 let submitted;runtime.bridge={request:async(method,path,body)=>{
  if(path==='/v1/accounts/capacity')return {accounts:[{accountId:'cf-held',occupied:1,available:0,retained:1},{accountId:'_cf-free',occupied:0,available:1,retained:0}]};
  if(path==='/v1/assignments'){submitted=body;return {assignmentId:'dag',state:'queued'};}throw Error('unexpected route');
 }};
 const s=submission();s.eligibleAccountIds=['cf-held','_cf-free'];s.tasks[0].execution={mode:'inference',provider:'cloudflare',model,maxOutputTokens:128};
 await runtime.callTool('job_submit',s,callerForInventory());assert.equal(submitted.tasks[0].execution.accountId,'_cf-free');
 const inventory=await runtime.callTool('job_workers',{projectId:'fleet'},callerForInventory());
 const held=inventory.inferenceResources.find(r=>r.accountId==='cf-held');assert.equal(held.availableCapacity,0);assert.equal(held.retainedCapacity,1);assert.equal(held.capacity,1);
});
