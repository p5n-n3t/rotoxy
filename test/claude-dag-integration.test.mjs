import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,chmod,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {StateStore} from '../dist/store.js';
import {SupervisorRuntime} from '../dist/supervisor-runtime.js';
import {AgentWorkspaceService} from '../dist/agent-workspace.js';
import {ClaudeWorkerRuntime} from '../dist/claude-worker-runtime.js';
import {ClaudeDagJobs} from '../dist/claude-dag-jobs.js';

test('real Python DAG dispatches two dependent Claude tasks through the existing attempt ledger and retrieves artifacts', {timeout:120000},async t=>{
 const dir=await mkdtemp(join(tmpdir(),'rx-claude-dag-integration-'));await chmod(dir,0o700);
 const prior=process.env.ROTOXY_CONFIG_DIR;process.env.ROTOXY_CONFIG_DIR=dir;
 const store=new StateStore();if(prior===undefined)delete process.env.ROTOXY_CONFIG_DIR;else process.env.ROTOXY_CONFIG_DIR=prior;
 await store.init({adminPassword:'synthetic-dag-test-password'});
 const binary=join(dir,'claude');const counter=join(dir,'launch-count');
 await writeFile(join(dir,'package.json'),'{"type":"module"}');
 await writeFile(binary,`#!${process.execPath}\nimport fs from 'node:fs';let input='';for await(const chunk of process.stdin)input+=chunk;fs.appendFileSync(${JSON.stringify(counter)},'launch\\n');console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:'Verified result\\nDONE',model:'test-haiku-model',total_cost_usd:0}));\n`,{mode:0o700});
 const profile={id:'claude-dag-test-profile',kind:'claude',label:'Test Claude',binary,cwd:dir,enabled:true,allowedModels:['test-haiku-model'],probeState:'available',probeCheck:'version',probeAt:1,probeOutput:'synthetic'};
 await writeFile(join(dir,'runner-profiles.json'),JSON.stringify({version:1,profiles:[profile]}),{mode:0o600});
 const accountId='claude-code:'+profile.id;
 const config={version:1,projects:[{projectId:'fleet',clientIds:['client-a'],accountIds:[accountId],registeredSessions:[]}],maxWorkers:2,allowUnknownQuota:true,localLimits:{maxTasks:100,maxJobBytes:1048576,maxOutputBytes:32768}};
 const runtime=new SupervisorRuntime(config,{configDir:dir,store,supervisorCwd:join(process.cwd(),'supervisor'),routingConfigDir:dir,supervisionDbPath:join(dir,'inbox.sqlite'),recoveryDbPath:join(dir,'recovery.sqlite'),oracleConfigPath:join(dir,'oracle-config.json'),oracleDbPath:join(dir,'oracle.sqlite'),oracleCachePath:join(dir,'oracle-cache.json'),oracleInventoryReader:async()=>({hosts:[]}),workerOptions:{pollIntervalMs:50}});
 const workspace=new AgentWorkspaceService(store,runtime);const claude=new ClaudeWorkerRuntime(store,workspace,runtime,[binary],[dir]);
 let restored;
 t.after(async()=>{await restored?.close();await claude.close();await runtime.close();await rm(dir,{recursive:true,force:true});});
 await runtime.start();
 assert.equal(runtime.status.workerStarted,false,'native dispatch waits for the actual executor attachment');
 runtime.setAgentExecutor(new ClaudeDagJobs(claude,workspace));
 assert.equal(runtime.status.workerStarted,true);
 const caller={clientId:'client-a',projectId:'fleet'};
 const task=(id,dependsOn)=>({taskId:id,dependsOn,scopeKeys:['record:'+id],instructions:'Inspect the supplied statement only and return Verified result.',execution:{mode:'agent',provider:'claude-code',profileId:profile.id,model:'test-haiku-model',timeoutMs:30000},output:{kind:'text',maxBytes:1024,format:'text',expectedMarker:'DONE'}});
 const submission={schemaVersion:1,jobId:'test-dag',idempotencyKey:'test-dag-idem',projectId:'fleet',eligibleAccountIds:[accountId],tasks:[task('one',[]),task('two',['one'])]};
 await runtime.callTool('job_submit',submission,caller);
 let status;
 const completionDeadline=Date.now()+90000;
 while(Date.now()<completionDeadline){
  status=await runtime.callTool('job_status',{projectId:'fleet',jobId:'test-dag'},caller);
  if(status.state==='complete'||status.state==='blocked')break;
  await new Promise(r=>setTimeout(r,200));
 }
 assert.equal(status.state,'complete',JSON.stringify(status));
 const results=await runtime.callTool('job_results',{projectId:'fleet',jobId:'test-dag'},caller);
 assert.equal(results.results.length,2);assert.equal((await readFile(counter,'utf8')).trim().split('\n').length,2);
 for(const result of results.results){assert.equal(result.reportedModel,'test-haiku-model');assert.ok(result.attemptId);assert.ok(result.artifactId);assert.equal(result.profileId,profile.id);assert.equal(result.text,'Verified result\nDONE');}
 await runtime.callTool('job_submit',submission,caller);
 assert.equal((await readFile(counter,'utf8')).trim().split('\n').length,2,'idempotent submission cannot launch again');
 const snapshot=await workspace.snapshot('fleet','client:client-a');assert.equal(snapshot.artifacts.length,2);
 // Cancellation must stop the owned child, not merely cancel the DAG's display.
 const pidFile=join(dir,'active-child.pid');
 await writeFile(binary,`#!${process.execPath}\nimport fs from 'node:fs';for await(const chunk of process.stdin){}fs.appendFileSync(${JSON.stringify(counter)},'launch\\n');fs.writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000);\n`,{mode:0o700});
 const cancelledSubmission={...submission,jobId:'cancel-dag',idempotencyKey:'cancel-dag-idem',tasks:[task('cancel',[])]};
 await runtime.callTool('job_submit',cancelledSubmission,caller);
 let pid;
 for(let i=0;i<150;i++){try{pid=Number(await readFile(pidFile,'utf8'));break;}catch{}await new Promise(r=>setTimeout(r,100));}
 assert.ok(pid,'owned fake CLI started');
 const cancel=await runtime.callTool('job_control',{projectId:'fleet',jobId:'cancel-dag',action:'cancel_job'},caller);
 assert.equal(cancel.localCancellationRequests,1);
 let gone=false;
 for(let i=0;i<100;i++){try{process.kill(pid,0);}catch{gone=true;break;}await new Promise(r=>setTimeout(r,50));}
 assert.equal(gone,true,'cancelled job stops its owned Claude child');
 const cancelledSnap=await workspace.snapshot('fleet','client:client-a');
 const cancelledTask=cancelledSnap.tasks.find(row=>row.title==='Job task cancel');assert.ok(cancelledTask);
 let attempt;
 for(let i=0;i<50;i++){attempt=await claude.call('claude_task_status',{projectId:'fleet',taskId:cancelledTask.id},'client-a');if(attempt.status==='ambiguous')break;await new Promise(r=>setTimeout(r,50));}
 assert.equal(attempt.status,'ambiguous');
 assert.equal((await readFile(counter,'utf8')).trim().split('\n').length,3,'cancel never launches replacement work');
 await runtime.close();
 restored=new SupervisorRuntime(config,{configDir:dir,store,supervisorCwd:join(process.cwd(),'supervisor'),routingConfigDir:dir,supervisionDbPath:join(dir,'inbox.sqlite'),recoveryDbPath:join(dir,'recovery.sqlite'),oracleConfigPath:join(dir,'oracle-config.json'),oracleDbPath:join(dir,'oracle.sqlite'),oracleCachePath:join(dir,'oracle-cache.json'),oracleInventoryReader:async()=>({hosts:[]}),workerOptions:{pollIntervalMs:50}});
 await restored.start();
 const recovered=await restored.callTool('job_results',{projectId:'fleet',jobId:'test-dag'},caller);
 assert.equal(recovered.results.length,2,'completed results survive a real supervisor process restart');
 await new Promise(r=>setTimeout(r,100));
 assert.equal((await readFile(counter,'utf8')).trim().split('\n').length,3,'restart does not replay completed or cancelled launches');
});
