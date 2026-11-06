import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StateStore } from '../dist/store.js';
import { CodexDagJobs } from '../dist/codex-dag-jobs.js';
import { CodexPoolPolicyStore } from '../dist/codex-pool-policy.js';
import { OriginProtectionStore } from '../dist/origin-protection.js';
import { AgentWorkspaceService } from '../dist/agent-workspace.js';
import { SupervisorRuntime } from '../dist/supervisor-runtime.js';

test('Codex crosses the real Python DAG and workspace ledgers, preserving receipt and artifact after restart', {timeout:90000}, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'rx-codex-integration-'));
  const previous = process.env.ROTOXY_CONFIG_DIR;
  process.env.ROTOXY_CONFIG_DIR = dir;
  const store = new StateStore();
  if (previous === undefined) delete process.env.ROTOXY_CONFIG_DIR; else process.env.ROTOXY_CONFIG_DIR = previous;
  await store.init({adminPassword:'test-password'});
  const target = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const native = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const accountId = 'codex:' + target;
  await writeFile(join(dir, 'codex-profiles.json'), JSON.stringify({version:1,profiles:[{id:target},{id:native}]}), {mode:0o600});
  await new CodexPoolPolicyStore(store).configure({version:1,dispatchEnabled:true,protectInitiatingAccount:true,profiles:[{profileId:target,enabled:true,maxConcurrent:1},{profileId:native,enabled:false,maxConcurrent:1}]});
  await new OriginProtectionStore(store).bindOrRenew({actor:{clientId:'client-a',sessionId:'test-origin'},nativeProfileId:native,profileAliases:[native],verifiedProviderAccountSubject:'native-subject',source:'trusted-server-resolver',expectedRevision:0,expiresAt:Date.now()+300000});
  const config = {version:1,projects:[{projectId:'fleet',clientIds:['client-a'],accountIds:['metadata-only'],registeredSessions:[]}],sharedWorkspace:{projectId:'fleet',membership:'authenticated_mcp'},maxWorkers:2,allowUnknownQuota:true,localLimits:{maxTasks:100,maxJobBytes:1048576,maxOutputBytes:32768}};
  const configPath=join(dir,'supervisor.json');
  await writeFile(configPath,JSON.stringify(config),{mode:0o600});
  const options = {configDir:dir,configPath,store,supervisorCwd:join(process.cwd(),'supervisor'),routingConfigDir:dir,supervisionDbPath:join(dir,'inbox.sqlite'),recoveryDbPath:join(dir,'recovery.sqlite'),oracleConfigPath:join(dir,'oracle.json'),oracleDbPath:join(dir,'oracle.sqlite'),oracleCachePath:join(dir,'oracle-cache.json'),oracleInventoryReader:async()=>({hosts:[]}),workerOptions:{pollIntervalMs:50}};
  let runtime = new SupervisorRuntime(config, options);
  let launches = 0;
  const profiles = {
    listProfiles:async()=>[],
    refreshProfile:async profileId=>({profileId,capturedAt:Date.now(),authMode:'chatgpt',planType:'plus',accountIdentity:'target-subject',models:[{id:'test-model',reasoningEfforts:['medium']}],rateWindows:[{limitId:'codex',slot:'primary',usedPercent:5,exhausted:false}]}),
    startExecution(request) {
      launches++;
      return {pendingRequests:[],cancel:async()=>{},promise:(async()=>{
        await request.authorizeSnapshot(await profiles.refreshProfile(target));
        await request.onReceipt({threadId:'test-thread',turnId:'test-turn'});
        return {profileId:target,threadId:'test-thread',turnId:'test-turn',modelId:'test-model',reasoningEffort:'medium',text:'Result\nDONE',status:'completed'};
      })()};
    },
  };
  let adapter;
  t.after(async()=>{await runtime.close();await adapter?.cancelAll();await rm(dir,{recursive:true,force:true});});
  const attach = () => {
    const workspace = new AgentWorkspaceService(store,runtime);
    adapter = new CodexDagJobs(store,profiles,workspace,dir);
    runtime.setAgentExecutor(adapter);
    return workspace;
  };
  attach();
  await runtime.start();
  const caller = {clientId:'client-a',projectId:'fleet'};
  const input = {schemaVersion:1,jobId:'codex-real-dag',idempotencyKey:'codex-real-dag',projectId:'fleet',eligibleAccountIds:[accountId],tasks:[{taskId:'one',dependsOn:[],scopeKeys:['record:one'],instructions:'Return Result.',execution:{mode:'agent',provider:'codex',profileId:target,model:'test-model',timeoutMs:10000,reasoningEffort:'medium',complexity:'routine',originSessionId:'test-origin'},output:{kind:'text',format:'text',maxBytes:1024,expectedMarker:'DONE'}}]};
  await runtime.callTool('job_submit',input,caller);
  let status;
  const deadline = Date.now()+60000;
  do {
    status = await runtime.callTool('job_status',{projectId:'fleet',jobId:input.jobId},caller);
    if (['complete','blocked'].includes(status.state)) break;
    await new Promise(resolve=>setTimeout(resolve,100));
  } while(Date.now()<deadline);
  assert.equal(status.state,'complete',JSON.stringify(status));
  let results = await runtime.callTool('job_results',{projectId:'fleet',jobId:input.jobId},caller);
  assert.equal(results.results.length,1);
  assert.equal(results.results[0].threadId,'test-thread');
  assert.equal(results.results[0].reasoningEffort,'medium');
  const workspace = new AgentWorkspaceService(store,runtime);
  const snapshot = await workspace.snapshot('fleet','client:client-a');
  assert.ok(snapshot.artifacts.some(artifact=>artifact.id===results.results[0].artifactId));
  assert.equal(launches,1);
  await runtime.close();
  runtime = new SupervisorRuntime(config,options);
  attach();
  await runtime.start();
  results = await runtime.callTool('job_results',{projectId:'fleet',jobId:input.jobId},caller);
  assert.equal(results.results[0].turnId,'test-turn');
  await runtime.callTool('job_submit',input,caller);
  assert.equal(launches,1);
});
