import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,chmod,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {StateStore} from '../dist/store.js';
import {AgentWorkspaceService} from '../dist/agent-workspace.js';
import {ClaudeWorkerRuntime} from '../dist/claude-worker-runtime.js';

test('real workspace bridge dispatches trusted fake CLI once, retains result after restart and isolates owners',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'rotoxy-claude-runtime-'));const old=process.env.ROTOXY_CONFIG_DIR;process.env.ROTOXY_CONFIG_DIR=dir;
 const store=new StateStore();if(old===undefined)delete process.env.ROTOXY_CONFIG_DIR;else process.env.ROTOXY_CONFIG_DIR=old;
 await store.init({adminPassword:'synthetic-claude-runtime-password'});await chmod(dir,0o700);
 const binary=join(dir,'claude');const counter=join(dir,'launch-count');
 await writeFile(binary,`#!/usr/bin/node\nimport fs from 'node:fs';\nconst args=process.argv.slice(2);let input='';for await(const chunk of process.stdin)input+=chunk;fs.appendFileSync(${JSON.stringify(counter)},'launch\\n');console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:'ROTOXY_CLAUDE_RUNTIME_OK',session_id:args[args.indexOf('--session-id')+1],model:'test-bedrock-model',total_cost_usd:0}));\n`,{mode:0o700});
 // Node treats this extensionless fixture as CommonJS; a package scope selects ESM.
 await writeFile(join(dir,'package.json'),'{"type":"module"}');
 const profile={id:'claude-runtime-test',kind:'claude',label:'Test Claude',cwd:dir,binary,enabled:true,allowedModels:['test-bedrock-model'],probeState:'available',probeCheck:'version',probeAt:1,probeOutput:'synthetic'};
 await writeFile(join(dir,'runner-profiles.json'),JSON.stringify({version:1,profiles:[profile]}),{mode:0o600});
 const backend={listProjects:()=>['project-a'],async authorizeWorkspace(project,client){if(project!=='project-a'||!['client-a','client-b'].includes(client))throw Error('not authorized');},async workspaceResources(){return [];}};
 const workspace=new AgentWorkspaceService(store,backend);const actor='client:client-a';
 let snap=await workspace.snapshot('project-a',actor);
 await workspace.update('project-a',actor,{action:'participant_upsert',label:'Caller',provider:'test',expectedRevision:snap.revision,idempotencyKey:'participant-a'});
 snap=await workspace.snapshot('project-a',actor);
 await workspace.update('project-a',actor,{action:'task_create',taskId:'task-a',title:'Check fixture',description:'Return marker',expectedRevision:snap.revision,idempotencyKey:'task-a'});
 const runtime=new ClaudeWorkerRuntime(store,workspace,backend,[binary],[dir]);t.after(async()=>{await runtime.close();await rm(dir,{recursive:true,force:true});});
 const workers=await runtime.call('claude_workers',{projectId:'project-a'},'client-a');assert.equal(workers.workers.length,1);
 const result=await runtime.call('claude_task_submit',{projectId:'project-a',taskId:'task-a',profileId:profile.id,model:'test-bedrock-model'},'client-a');assert.equal(result.accepted,true);
 let status;
 for(let i=0;i<30;i++){status=await runtime.call('claude_task_status',{projectId:'project-a',taskId:'task-a'},'client-a');if(!['intent','running'].includes(status.status))break;await new Promise(r=>setTimeout(r,50));}
 assert.equal(status.status,'success',JSON.stringify(status));assert.equal(status.result,'ROTOXY_CLAUDE_RUNTIME_OK');
 const reviewed=await workspace.snapshot('project-a',actor);assert.equal(reviewed.tasks[0].state,'review');assert.equal(reviewed.artifacts.length,1);
 await runtime.call('claude_task_submit',{projectId:'project-a',taskId:'task-a',profileId:profile.id,model:'test-bedrock-model'},'client-a');
 assert.equal((await readFile(counter,'utf8')).trim(),'launch','no second process');
 assert.deepEqual(await runtime.call('claude_task_status',{projectId:'project-a',taskId:'task-a'},'client-b'),{found:false});
 const restarted=new ClaudeWorkerRuntime(store,workspace,backend,[binary],[dir]);t.after(()=>restarted.close());
 assert.equal((await restarted.call('claude_task_status',{projectId:'project-a',taskId:'task-a'},'client-a')).status,'success');
});

test('cancelled fake CLI becomes ambiguous and blocks the task without a duplicate launch',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'rotoxy-claude-cancel-'));const old=process.env.ROTOXY_CONFIG_DIR;process.env.ROTOXY_CONFIG_DIR=dir;
 const store=new StateStore();if(old===undefined)delete process.env.ROTOXY_CONFIG_DIR;else process.env.ROTOXY_CONFIG_DIR=old;
 await store.init({adminPassword:'synthetic-claude-cancel-password'});await chmod(dir,0o700);
 const binary=join(dir,'claude');const counter=join(dir,'launch-count');
 await writeFile(binary,`#!/usr/bin/node\nimport fs from 'node:fs';\nfs.appendFileSync(${JSON.stringify(counter)},'launch\\n');\nsetInterval(()=>{},1000);\n`,{mode:0o700});
 await writeFile(join(dir,'package.json'),' {"type":"module"} ');
 const profile={id:'claude-cancel-test',kind:'claude',label:'Cancel test',cwd:dir,binary,enabled:true,allowedModels:['test-bedrock-model'],probeState:'available',probeCheck:'version',probeAt:1,probeOutput:'synthetic'};
 await writeFile(join(dir,'runner-profiles.json'),JSON.stringify({version:1,profiles:[profile]}),{mode:0o600});
 const backend={listProjects:()=>['project-a'],async authorizeWorkspace(project,client){if(project!=='project-a'||!['client-a','client-b'].includes(client))throw Error('not authorized');},async workspaceResources(){return [];}};
 const workspace=new AgentWorkspaceService(store,backend);const actor='client:client-a';
 let snap=await workspace.snapshot('project-a',actor);
 await workspace.update('project-a',actor,{action:'participant_upsert',label:'Caller',provider:'test',expectedRevision:snap.revision,idempotencyKey:'cancel-participant'});
 snap=await workspace.snapshot('project-a',actor);
 await workspace.update('project-a',actor,{action:'task_create',taskId:'task-cancel',title:'Long running task',description:'Wait until the owner cancels this run.',expectedRevision:snap.revision,idempotencyKey:'cancel-task'});
 const runtime=new ClaudeWorkerRuntime(store,workspace,backend,[binary],[dir]);t.after(async()=>{await runtime.close();await rm(dir,{recursive:true,force:true});});
 const submitted=await runtime.call('claude_task_submit',{projectId:'project-a',taskId:'task-cancel',profileId:profile.id,model:'test-bedrock-model'},'client-a');
 assert.equal(submitted.accepted,true);
 for(let i=0;i<500;i++){try{if((await readFile(counter,'utf8')).trim()==='launch')break;}catch{}await new Promise(r=>setTimeout(r,20));}
 assert.equal((await readFile(counter,'utf8')).trim(),'launch','fake CLI started exactly once before cancellation');
 const cancelled=await runtime.call('claude_task_cancel',{projectId:'project-a',taskId:'task-cancel'},'client-a');
 assert.equal(cancelled.requested,true,JSON.stringify(cancelled));
 let status;
 for(let i=0;i<50;i++){status=await runtime.call('claude_task_status',{projectId:'project-a',taskId:'task-cancel'},'client-a');if(status.status==='ambiguous')break;await new Promise(r=>setTimeout(r,20));}
 assert.equal(status.status,'ambiguous',JSON.stringify(status));
 let blocked;
 for(let i=0;i<50;i++){blocked=await workspace.snapshot('project-a',actor);if(blocked.tasks.find(row=>row.id==='task-cancel').state==='blocked')break;await new Promise(r=>setTimeout(r,20));}
 assert.equal(blocked.tasks.find(row=>row.id==='task-cancel').state,'blocked');
 const replay=await runtime.call('claude_task_submit',{projectId:'project-a',taskId:'task-cancel',profileId:profile.id,model:'test-bedrock-model'},'client-a');
 assert.equal(replay.accepted,false);assert.equal(replay.state,'task_not_claimable');
 assert.equal((await readFile(counter,'utf8')).trim(),'launch','ambiguous cancelled work never launches a second child');
});
