import { createHash } from 'node:crypto';
import type { AgentJobExecutor, AgentResource, JobOperation, JobResult } from './job-worker.js';
import type { AgentWorkspaceService } from './agent-workspace.js';
import type { ClaudeWorkerRuntime } from './claude-worker-runtime.js';

/** The durable scheduler owns dispatch; the existing workspace ledger owns the
 * single Claude launch. A scheduler operation always maps to the same task. */
export class ClaudeDagJobs implements AgentJobExecutor {
 private readonly active=new Map<string,{projectId:string;jobId:string;clientId:string;taskId:string;cancelled:boolean}>();
 constructor(private readonly runtime:Pick<ClaudeWorkerRuntime,'call'|'resources'>,
  private readonly workspace:Pick<AgentWorkspaceService,'snapshot'|'update'>,
  private readonly sleep=(ms:number)=>new Promise<void>(r=>setTimeout(r,ms))){}
 resources():Promise<AgentResource[]>{return this.runtime.resources();}
 async cancelJob(projectId:string,jobId:string,clientId:string):Promise<number>{
  let requested=0;
  for(const row of this.active.values())if(row.projectId===projectId&&row.jobId===jobId&&row.clientId===clientId){
   row.cancelled=true;requested++;
   try{await this.runtime.call('claude_task_cancel',{projectId:row.projectId,taskId:row.taskId},row.clientId);}catch{/* Durable cancellation still prevents replay. */}
  }
  return requested;
 }
 async cancelAll():Promise<void>{await Promise.all([...this.active.values()].map(row=>this.cancelJob(row.projectId,row.jobId,row.clientId)));}
 async invoke(op:JobOperation):Promise<JobResult<Record<string,unknown>>>{
  const rejected=(reason:string):JobResult<Record<string,unknown>>=>({accountId:op.selectedAccountId,classification:'rejected',reason});
  const ambiguous=(reason:string):JobResult<Record<string,unknown>>=>({accountId:op.selectedAccountId,classification:'ambiguous',reason});
  const i=op.input;const safe=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
  if(op.kind!=='run_agent'||typeof i.projectId!=='string'||!safe.test(i.projectId)||typeof i.clientId!=='string'||
    !/^[A-Za-z0-9_-]{1,128}$/.test(i.clientId)||typeof i.profileId!=='string'||!safe.test(i.profileId)||
    typeof i.model!=='string'||typeof i.prompt!=='string'||Buffer.byteLength(i.prompt)>16384||
    typeof i.expectedMarker!=='string'||!Number.isSafeInteger(i.timeoutMs)||Number(i.timeoutMs)<100||Number(i.timeoutMs)>120000||
    op.selectedAccountId!=='claude-code:'+i.profileId)return rejected('invalid_agent_binding');
  const resource=(await this.resources()).find(r=>r.accountId===op.selectedAccountId&&r.profileId===i.profileId&&r.models.includes(String(i.model)));
  if(!resource)return rejected('agent_binding_unavailable');
  const taskId='dag-'+createHash('sha256').update(op.operationId).digest('hex').slice(0,40);
  const binding={projectId:i.projectId,jobId:String(i.jobId??''),clientId:i.clientId,taskId,cancelled:false};
  this.active.set(op.operationId,binding);
  const actor='client:'+i.clientId;const requestStartedAt=Date.now()/1000;
  let launched=false;
  try{
   let snap=await this.workspace.snapshot(i.projectId,actor);
   const current=snap.tasks.find((row:any)=>row.id===taskId) as any;
   if(!current){
    if(!snap.participants.some((row:any)=>row.id===actor)){
     await this.workspace.update(i.projectId,actor,{action:'participant_upsert',label:'Job orchestrator',provider:'rotoxy',expectedRevision:snap.revision,idempotencyKey:taskId+'-actor'});
     snap=await this.workspace.snapshot(i.projectId,actor);
    }
    await this.workspace.update(i.projectId,actor,{action:'task_create',taskId,title:'Job task '+String(i.taskId??taskId).slice(0,100),description:i.prompt,
     expectedRevision:snap.revision,idempotencyKey:taskId+'-create'});
   }else if(current.description!==i.prompt)return ambiguous('agent_task_content_mismatch');
   let status=await this.runtime.call('claude_task_status',{projectId:i.projectId,taskId},i.clientId) as any;
   if(binding.cancelled)return rejected('agent_cancelled_before_launch');
   if(!status.found){
    // Set this before the call: a lost response must never be treated as safe to retry.
    launched=true;
    const receipt=await this.runtime.call('claude_task_submit',{projectId:i.projectId,taskId,profileId:i.profileId,model:i.model,timeoutMs:i.timeoutMs},i.clientId) as any;
    if(!receipt.accepted&&!receipt.replayed)return rejected('agent_dispatch_not_accepted');
   }else launched=true;
   if(binding.cancelled){await this.runtime.call('claude_task_cancel',{projectId:i.projectId,taskId},i.clientId);return ambiguous('agent_cancellation_requested');}
   const deadline=Date.now()+Number(i.timeoutMs)+10000;
   do{
    status=await this.runtime.call('claude_task_status',{projectId:i.projectId,taskId},i.clientId) as any;
    if(binding.cancelled)return ambiguous('agent_cancellation_requested');
    if(status.found&&!['intent','running'].includes(status.status))break;
    await this.sleep(1000);
   }while(Date.now()<deadline);
   if(status.status!=='success')return ambiguous('agent_'+(typeof status.status==='string'?status.status:'outcome_unavailable'));
   if(status.modelRequested!==i.model||status.modelReported!==i.model||typeof status.result!=='string'||
    typeof status.attemptId!=='string')return ambiguous('agent_result_identity_mismatch');
   const artifactId=status.attemptId+'-result';
   snap=await this.workspace.snapshot(i.projectId,actor);
   if(!snap.artifacts.some((row:any)=>row.id===artifactId&&row.taskId===taskId))return ambiguous('agent_artifact_unavailable');
   return {accountId:op.selectedAccountId,classification:'accepted',value:{assistantText:status.result,reportedModel:status.modelReported,
    attemptId:status.attemptId,artifactId,profileId:i.profileId,requestStartedAt,assistantAt:Date.now()/1000,
    ...(typeof status.costUsd==='number'?{costUsd:status.costUsd}:{})}};
  }catch{return launched?ambiguous('agent_launch_or_result_unconfirmed'):rejected('agent_workspace_unavailable');}
  finally{this.active.delete(op.operationId);}
 }
}
