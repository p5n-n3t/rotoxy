import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import type { StateStore } from './store.js';
import type { SupervisorBackend, SupervisorCaller } from './supervisor-api.js';
import { AgentWorkspaceService, runWorkspacePython } from './agent-workspace.js';
import { ClaudeWorkspaceDispatch } from './claude-workspace-dispatch.js';
import { ClaudeTaskDispatch, readClaudeRunnerProfiles } from './claude-task-dispatch.js';
import { ClaudeCodeJobs } from './providers/claude-code-jobs.js';
import { loadBedrockCredentialSource } from './bedrock-credential-source.js';

const SAFE=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CWD=fileURLToPath(new URL('../supervisor/',import.meta.url));
export const CLAUDE_WORKER_TOOLS=[
 {name:'claude_workers',description:'Discover enabled trusted local Claude Code profiles powered by Bedrock. These are agent workers, not HTTP inference models.',inputSchema:{type:'object',properties:{projectId:{type:'string'}},required:['projectId'],additionalProperties:false}},
 {name:'claude_task_submit',description:'Dispatch one queued workspace task to an enabled Claude Code profile with an explicit allowed model and a durable no-replay attempt. Input comes from the stored task, not a caller-supplied executable or prompt. Results require review.',inputSchema:{type:'object',properties:{projectId:{type:'string'},taskId:{type:'string'},profileId:{type:'string'},model:{type:'string'},timeoutMs:{type:'integer',minimum:100,maximum:900000}},required:['projectId','taskId','profileId','model'],additionalProperties:false}},
 {name:'claude_task_status',description:'Read the caller-owned durable Claude attempt and bounded result. No provider work is launched or replayed.',inputSchema:{type:'object',properties:{projectId:{type:'string'},taskId:{type:'string'}},required:['projectId','taskId'],additionalProperties:false}},
 {name:'claude_task_cancel',description:'Request cancellation of the caller-owned active Claude child only. Cancellation after launch preserves an ambiguous outcome for review; it does not undo actions already performed.',inputSchema:{type:'object',properties:{projectId:{type:'string'},taskId:{type:'string'}},required:['projectId','taskId'],additionalProperties:false}},
] as const;
export function isClaudeWorkerTool(name:unknown):name is typeof CLAUDE_WORKER_TOOLS[number]['name']{return CLAUDE_WORKER_TOOLS.some(tool=>tool.name===name);}
export function claudeWorkerScope(name:string):'jobs:read'|'jobs:write'{return name==='claude_task_submit'||name==='claude_task_cancel'?'jobs:write':'jobs:read';}

/** Existing workspace DB and runner registry; no second task scheduler or credential store. */
export class ClaudeWorkerRuntime {
 private service?:ClaudeWorkspaceDispatch;
 private readonly active=new Map<string,{cancel():void;promise:Promise<unknown>}>();
 private readonly bindings=new Map<string,{projectId:string;taskId:string;ownerClientId:string}>();
 private readonly attemptHandles=new Map<string,{cancel():void}>();
 private closed=false;
 private pendingStarts=0;
 private submitting=false;
 private readonly startedAt=Math.floor(Date.now()/1000);
 private workerActor(clientId:string){return 'client:claude-worker-'+createHash('sha256').update(clientId).digest('hex').slice(0,24);}
 constructor(private readonly store:StateStore,private readonly workspace:AgentWorkspaceService,private readonly backend:SupervisorBackend,private readonly allowedExecutables:readonly string[],private readonly allowedCwds:readonly string[]){}
 private async ledger(input:Record<string,unknown>):Promise<any>{
  const output=await runWorkspacePython('/usr/bin/python3',['-m','snooze.claude_workspace_worker','--db',join(this.store.dir,'agent-workspace.sqlite3'),'--ledger'],JSON.stringify(input),{cwd:CWD,timeoutMs:10000,maxStdoutBytes:65536});
  const value=JSON.parse(output);if(value?.error)throw new Error('claude_attempt_operation_failed');return value;
 }
 private async authorize(projectId:string,clientId:string){if(!SAFE.test(projectId)||!/^[A-Za-z0-9_-]{1,128}$/.test(clientId)||!this.backend.authorizeWorkspace)throw Error('claude_worker_not_authorized');await this.backend.authorizeWorkspace(projectId,clientId);}
 private async prepare():Promise<ClaudeWorkspaceDispatch>{
  if(this.service)return this.service;
  const env=await loadBedrockCredentialSource(process.env.ROTOXY_BEDROCK_CREDENTIAL_SOURCE);
  const jobs=new ClaudeCodeJobs({allowedExecutables:this.allowedExecutables,allowedCwds:this.allowedCwds,bedrockEnv:env,maxBudgetUsd:0.25});
  const dispatch=new ClaudeTaskDispatch({registryPath:join(this.store.dir,'runner-profiles.json'),allowedExecutables:this.allowedExecutables,allowedCwds:this.allowedCwds,jobs});
  const source={
   resolveOwnedTask:async({projectId,taskId,caller}:{projectId:string;taskId:string;caller:SupervisorCaller})=>{
    await this.authorize(projectId,caller.clientId);
    const snap=await this.workspace.snapshot(projectId,'client:'+caller.clientId);
    const task=snap.tasks.find((row:any)=>row.id===taskId) as any;
    if(!task)return undefined;
    return {projectId,taskId,title:task.title,description:task.description,state:task.state};
   },
   claimTask:async({projectId,taskId,caller,attemptId}:{projectId:string;taskId:string;caller:SupervisorCaller;attemptId:string})=>{
    await this.authorize(projectId,caller.clientId);
    const actor=this.workerActor(caller.clientId);
    let snap=await this.workspace.snapshot(projectId,actor);
    await this.workspace.update(projectId,actor,{action:'participant_upsert',idempotencyKey:attemptId+'-participant',expectedRevision:snap.revision,label:'Claude Code via Bedrock',provider:'claude-code'});
    snap=await this.workspace.snapshot(projectId,actor);
    await this.workspace.update(projectId,actor,{action:'task_claim',idempotencyKey:attemptId+'-claim',expectedRevision:snap.revision,taskId});
   },
   publishResult:async({projectId,taskId,caller,attemptId,text,modelReported}:{projectId:string;taskId:string;caller:SupervisorCaller;attemptId:string;text:string;modelReported?:string})=>{
    await this.authorize(projectId,caller.clientId);const actor=this.workerActor(caller.clientId);
    const snap=await this.workspace.snapshot(projectId,actor);const artifactId=attemptId+'-result';
    await this.workspace.update(projectId,actor,{action:'artifact_submit',idempotencyKey:attemptId+'-artifact',expectedRevision:snap.revision,artifactId,taskId,kind:'text',reference:(text.length>900?text.slice(0,850)+' [Preview; retrieve full result with claude_task_status]':text)||'Worker returned an empty result',title:('Claude result · '+(modelReported||'model not reported')).slice(0,256)});
    return {artifactId};
   },
  };
  this.service=new ClaudeWorkspaceDispatch(source,{
   reserve:async input=>{const result=await this.ledger({command:'reserve',...input});this.bindings.set(result.attemptId,{projectId:input.projectId,taskId:input.taskId,ownerClientId:input.ownerClientId});return result;},
   update:async input=>{const binding=this.bindings.get(input.attemptId);if(!binding)throw Error('claude_attempt_binding_missing');await this.ledger({command:'update',...binding,...input});
    if(['error','ambiguous','artifact_failed'].includes(input.status))await this.blockTask(binding,input.attemptId);
    if(['success','error','ambiguous','artifact_failed'].includes(input.status)){this.bindings.delete(input.attemptId);this.attemptHandles.delete(input.attemptId);}
   },
  },{start:async input=>{
   if(this.closed||this.active.size+this.pendingStarts>=1)throw Error('claude_worker_capacity_unavailable');
   this.pendingStarts++;
   try {
    const handle=await dispatch.start(input);this.active.set(handle.runId,handle);
    void handle.promise.finally(()=>this.active.delete(handle.runId)).catch(()=>undefined);
    return {...handle,promise:handle.promise.then(result=>{
      let text=result.text;
      for(const value of [env.AWS_ACCESS_KEY_ID,env.AWS_SECRET_ACCESS_KEY,env.AWS_SESSION_TOKEN])if(value&&value.length>=12)text=text.split(value).join('[REDACTED]');
      return {...result,text};
    })};
   } finally {this.pendingStarts--;}
  }});
  return this.service;
 }
 async call(name:string,raw:unknown,clientId:string):Promise<unknown>{
  if(!raw||typeof raw!=='object'||Array.isArray(raw))throw Error('invalid_claude_worker_input');
  const args=raw as Record<string,unknown>;if(typeof args.projectId!=='string')throw Error('invalid_claude_worker_input');
  await this.authorize(args.projectId,clientId);
  const allowed=name==='claude_workers'?['projectId']:['claude_task_status','claude_task_cancel'].includes(name)?['projectId','taskId']:['projectId','taskId','profileId','model','timeoutMs'];
  if(Object.keys(args).some(key=>!allowed.includes(key)))throw Error('invalid_claude_worker_input');
  if(name==='claude_workers'){
   const rows=await readClaudeRunnerProfiles(join(this.store.dir,'runner-profiles.json'));
   return {projectId:args.projectId,workers:rows.filter(row=>row.enabled&&this.allowedExecutables.includes(row.binary)&&this.allowedCwds.includes(row.cwd)).map(row=>({profileId:row.id,provider:'claude-code',inferenceProvider:'bedrock',models:row.allowedModels,capacity:1,tools:['Read','Glob','Grep'],maxBudgetUsd:0.25,taskInterface:'workspace-task',mainDagIntegration:false})),activeWorkers:this.active.size};
  }
  if(typeof args.taskId!=='string'||!SAFE.test(args.taskId))throw Error('invalid_claude_worker_task');
  if(name==='claude_task_cancel'){
   const row=await this.ledger({command:'status',projectId:args.projectId,taskId:args.taskId,ownerClientId:clientId});
   if(!row.found)return {requested:false,state:'attempt_unavailable'};
   if(!['intent','running'].includes(row.status))return {requested:false,state:row.status};
   const handle=this.attemptHandles.get(row.attemptId);
   if(!handle)return {requested:false,state:'needs_reconciliation'};
   handle.cancel();return {requested:true,state:'cancellation_requested',attemptId:row.attemptId};
  }
  if(name==='claude_task_status'){
   const binding={projectId:args.projectId,taskId:args.taskId,ownerClientId:clientId};
   const row=await this.ledger({command:'status',...binding});
   if(row.found && ['intent','running'].includes(row.status) && !this.bindings.has(row.attemptId) && Number(row.createdAt)<=this.startedAt){
    await this.ledger({command:'reconcile',...binding,staleBefore:this.startedAt});
    await this.blockTask(binding,row.attemptId);
    return this.ledger({command:'status',...binding});
   }
   return row;
  }
  if(name!=='claude_task_submit'||this.closed)throw Error('claude_worker_unavailable');
  if(typeof args.model!=='string'||!args.model)throw Error('explicit_claude_model_required');
  const profile=(await readClaudeRunnerProfiles(join(this.store.dir,'runner-profiles.json'))).find(row=>row.id===args.profileId);
  if(!profile?.enabled||!this.allowedExecutables.includes(profile.binary)||!this.allowedCwds.includes(profile.cwd)||!profile.allowedModels.includes(args.model))throw Error('claude_profile_or_model_not_allowed');
  if(this.active.size+this.pendingStarts>=1||this.submitting)throw Error('claude_worker_capacity_unavailable');
  this.submitting=true;
  try{
   const result=await (await this.prepare()).submit(args,{projectId:args.projectId,clientId});
   if(result.accepted&&result.attemptId){const handle=[...this.active.values()][0];if(handle)this.attemptHandles.set(result.attemptId,handle);}
   return result;
  }
  finally{this.submitting=false;}
 }
 private async blockTask(binding:{projectId:string;taskId:string;ownerClientId:string},attemptId:string){
  try{const actor=this.workerActor(binding.ownerClientId);const snap=await this.workspace.snapshot(binding.projectId,actor);
   const task=snap.tasks.find((row:any)=>row.id===binding.taskId) as any;
   if(task?.assignee===actor&&['running','blocked'].includes(task.state))await this.workspace.update(binding.projectId,actor,{action:'task_update',taskId:binding.taskId,state:'blocked',note:'Claude attempt requires review; inspect claude_task_status before taking further action.',idempotencyKey:attemptId+'-blocked',expectedRevision:snap.revision});
  }catch{/* Durable attempt state remains the recovery source; never launch another worker. */}
 }
 async close(){this.closed=true;for(const handle of this.active.values())handle.cancel();await Promise.allSettled([...this.active.values()].map(handle=>handle.promise));}
}
