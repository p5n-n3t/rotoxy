#!/usr/bin/env node
/** Read-only LightSprint observation plus durable local guidance. No cloud chat/launch. */
import { readFile, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CreditSnapshotStore } from '../dist/credit-snapshots.js';
import { StateStore } from '../dist/store.js';
import { serverMessages } from '../dist/jsonrpc-wire.js';
import { boundObservationDiagnostics, classifyObservationFailure, normalizeSessionObservation, WorkerObservationFailure } from '../dist/worker-observation.js';
import { runDesktopAlarm } from './desktop-alarm-hook.mjs';
import { childExitState } from './monitor-lifecycle.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const configPath=process.argv[2];
if(!configPath)throw Error('private_config_required');
const st=await stat(configPath);
if((st.mode&0o077)!==0||st.uid!==process.getuid())throw Error('private_config_required');
const cfg=JSON.parse(await readFile(configPath,'utf8'));
const safe=x=>typeof x==='string'&&/^[A-Za-z0-9_.:-]{1,160}$/.test(x);
if(!Array.isArray(cfg.workers)||cfg.workers.length>1000||!cfg.workers.every(w=>['id','accountId','sessionId','owner','job'].every(k=>safe(w[k])))||
    new Set(cfg.workers.map(w=>w.id)).size!==cfg.workers.length||!Number.isInteger(cfg.intervalSeconds)||cfg.intervalSeconds<60||cfg.intervalSeconds>3600)throw Error('invalid_config');
for(const k of ['inboxDb','poolConfig','poolDb'])if(typeof cfg[k]!=='string'||!cfg[k].startsWith('/'))throw Error('absolute_private_paths_required');
if(cfg.recoveryServiceConfig!==undefined&&(typeof cfg.recoveryServiceConfig!=='string'||!cfg.recoveryServiceConfig.startsWith('/')))throw Error('absolute_private_paths_required');
if(cfg.desktopAlarm!==undefined){
  const alarm=cfg.desktopAlarm;
  if(cfg.recoveryServiceConfig===undefined||typeof alarm!=='object'||alarm===null||Array.isArray(alarm)||
      Object.keys(alarm).sort().join(',')!=='receiptsDb,sourceDb'||
      ['sourceDb','receiptsDb'].some(k=>typeof alarm[k]!=='string'||!alarm[k].startsWith('/')))throw Error('invalid_desktop_alarm_config');
}
const store=new StateStore();
let stopping=false,phase="startup";
process.on('SIGTERM',()=>{stopping=true;});process.on('SIGINT',()=>{stopping=true;});
function python(command,item){return new Promise((yes,no)=>{
  const args=['-m','snooze.guidance','--db',cfg.inboxDb,command];
  if(command==='guide')args.push('--pool-config',cfg.poolConfig,'--pool-db',cfg.poolDb);
  const p=spawn('/usr/bin/python3',args,{cwd:root,env:{...process.env,PYTHONPATH:resolve(root,'supervisor')},stdio:['pipe','pipe','ignore']});
  let out='',size=0;const limit=command==='registrations'?1024*1024:16384;const timer=setTimeout(()=>p.kill('SIGKILL'),60000);
  p.stdout.on('data',b=>{size+=b.length;if(size>limit)p.kill('SIGKILL');else out+=b;});
  p.on('error',()=>{clearTimeout(timer);no(Error('guidance_unavailable'));});
  p.on('exit',(code,signal)=>{clearTimeout(timer);const state=childExitState(stopping,code,signal);if(state==='stopped')return yes({stopped:true});if(state==='failed')no(Error('guidance_failed'));else{try{yes(JSON.parse(out));}catch{no(Error('guidance_invalid_receipt'));}}});
  p.stdin.on('error',()=>{});p.stdin.end(item?JSON.stringify(item):'');
});}
function recoveryOnce(){return new Promise((yes,no)=>{
  const p=spawn('/usr/bin/python3',['-m','snooze.recovery_service','--config',cfg.recoveryServiceConfig,'--once'],
    {cwd:root,env:{...process.env,PYTHONPATH:resolve(root,'supervisor')},stdio:['ignore','pipe','ignore']});
  let out='',size=0;const timer=setTimeout(()=>p.kill('SIGKILL'),60000);
  p.stdout.on('data',b=>{size+=b.length;if(size>16384)p.kill('SIGKILL');else out+=b;});
  p.on('error',()=>{clearTimeout(timer);no(Error('recovery_service_unavailable'));});
  p.on('exit',(code,signal)=>{clearTimeout(timer);const state=childExitState(stopping,code,signal);if(state==='stopped')return yes({stopped:true});if(state==='failed')no(Error('recovery_service_failed'));else{try{yes(JSON.parse(out));}catch{no(Error('recovery_service_invalid_receipt'));}}});
});}
async function observation(worker,state){
  const account=state.accounts.find(a=>a.id===worker.accountId);
  if(!account)throw new WorkerObservationFailure('account_missing');
  // The only remote paths are initialize and this exact bound status endpoint.
  let token;try{token=await store.revealToken(account);}catch{throw new WorkerObservationFailure('account_unavailable');}let session;let id=0;
  async function rpc(method,params){
    const callId=++id;
    try{
      const r=await fetch(state.config.upstreamUrl,{method:'POST',headers:{authorization:'Bearer '+token,accept:'application/json, text/event-stream','content-type':'application/json',...(session?{'mcp-session-id':session,'mcp-protocol-version':'2025-06-18'}:{})},body:JSON.stringify({jsonrpc:'2.0',id:callId,method,params}),signal:AbortSignal.timeout(20000)});
      session=r.headers.get('mcp-session-id')||session;
      if(!r.ok){await r.body?.cancel().catch(()=>{});throw new WorkerObservationFailure('http_status',r.status);}
      const reader=r.body?.getReader();if(!reader)throw new WorkerObservationFailure('malformed_protocol');
      const chunks=[];let bytes=0;
      while(true){const part=await reader.read();if(part.done)break;bytes+=part.value.byteLength;if(bytes>1024*1024){await reader.cancel();throw new WorkerObservationFailure('malformed_protocol');}chunks.push(Buffer.from(part.value));}
      let messages;try{messages=serverMessages(r.headers.get('content-type'),Buffer.concat(chunks).toString('utf8'));}catch{throw new WorkerObservationFailure('malformed_protocol');}
      const value=messages.find(x=>x.id===callId);
      if(!value||value.error||value.result?.isError)throw new WorkerObservationFailure('malformed_protocol');return value.result;
    }catch(error){
      if(error instanceof WorkerObservationFailure)throw error;
      throw new WorkerObservationFailure(error?.name==='TimeoutError'||error?.name==='AbortError'?'timeout':'transport_error');
    }
  }
  const init=await rpc('initialize',{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'token2oauth-readonly-monitor',version:'1'}});
  if(!init?.serverInfo)throw new WorkerObservationFailure('malformed_protocol');
  const result=await rpc('tools/call',{name:'lightsprint_api',arguments:{method:'GET',path:'/api/agent-sessions/'+worker.sessionId+'/status'}});
  const content=Array.isArray(result?.content)?result.content.find(c=>c?.type==='text')?.text:undefined;
  let raw;try{if(typeof content!=='string')throw Error();raw=JSON.parse(content);}catch{throw new WorkerObservationFailure('malformed_protocol');}
  const s=raw?.status;
  if(!s||typeof s!=='object'||Array.isArray(s))throw new WorkerObservationFailure('session_missing');
  if(typeof s.sessionId!=='string')throw new WorkerObservationFailure('session_missing');
  if(s.sessionId!==worker.sessionId)throw new WorkerObservationFailure('session_mismatch');
  if(s.isOwner!==true)throw new WorkerObservationFailure('owner_mismatch');
  const cost=s.aiGatewaySessionCostUsd;
  if(typeof cost==='number'&&Number.isFinite(cost)&&cost>=0){
    try{
      const ledger=new CreditSnapshotStore([{provider:'lightsprint',accountId:account.id,label:account.label,unit:'credits'}],{directory:store.dir});
      const receipt=await ledger.recordSessionCost({provider:'lightsprint',accountId:account.id,sessionId:worker.sessionId,totalUsd:cost,observedAt:Date.now(),...(safe(s.model)?{model:s.model}:{})});
      if(receipt.status==='counter_decreased')console.error(JSON.stringify({event:'session_cost_counter_decreased',accountId:account.id,sessionId:worker.sessionId}));
    }catch{console.error(JSON.stringify({event:'session_cost_accounting_unavailable',accountId:account.id,sessionId:worker.sessionId}));}
  }
  const observed=normalizeSessionObservation(s);
  return{...observed,...(safe(s.model)?{model:s.model}:{}),
    ...(Number.isSafeInteger(s.promptCount)&&s.promptCount>=0?{promptCount:s.promptCount}:{})};
}
async function check(){
  phase="configuration";const state=await store.load();let checked=0,errors=0;const observationFailures=[];
  phase='registrations';const registered=await python('registrations');
  const workers=[...cfg.workers,...(Array.isArray(registered?.workers)?registered.workers.filter(w=>
    ['id','project','owner','account_id','session_id'].every(k=>safe(w[k]))
  ).map(w=>({id:w.id,projectId:w.project,owner:w.owner,accountId:w.account_id,sessionId:w.session_id,job:w.project})):[])];
  // One provider status read per account/session; each owner still receives a
  // separately scoped inbox observation after the shared result is fetched.
  const groups=new Map();
  for(const worker of workers){const key=JSON.stringify([worker.accountId,worker.sessionId]);if(!groups.has(key))groups.set(key,[]);groups.get(key).push(worker);}
  const unique=[...groups.values()];
  phase="observations";for(let i=0;i<unique.length&&!stopping;i+=3){
    await Promise.all(unique.slice(i,i+3).map(async group=>{
      const representative=group[0];let o;try{o=await observation(representative,state);}catch(error){o={state:'unavailable'};errors++;observationFailures.push({accountId:representative.accountId,sessionId:representative.sessionId,...classifyObservationFailure(error)});}
      // Bound child processes across owners as well as remote sessions.
      for(const worker of group)await python('observe',{worker:worker.id,observation:o,owner:worker.owner,job:worker.job});
      checked+=group.length;
    }));
  }
  if(stopping)return;
  phase='guidance';const guide=cfg.guide===true?await python('guide'):undefined;
  if(stopping)return;
  phase='recovery';let recovery,recoveryStatus=cfg.recoveryServiceConfig?'completed':'not_configured';
  if(cfg.recoveryServiceConfig){
    try{recovery=await recoveryOnce();}
    catch{recoveryStatus='failed';console.error(JSON.stringify({at:new Date().toISOString(),event:'recovery_service_outcome',status:'failed',error:'recovery_service_failed'}));}
  }
  let desktopAlarm={status:'not_configured',scanned:0,submitted:0,failed:0,ambiguous:0};
  if(cfg.desktopAlarm&&!stopping){
    desktopAlarm=await runDesktopAlarm({config:cfg.desktopAlarm,root});
    if(desktopAlarm.status!=='completed')console.error(JSON.stringify({at:new Date().toISOString(),event:'desktop_alarm_outcome',...desktopAlarm}));
  }
  const diagnostics=boundObservationDiagnostics(observationFailures);
  console.log(JSON.stringify({at:new Date().toISOString(),checked,statusErrors:errors,observationDiagnostics:diagnostics.items,observationDiagnosticsOmitted:diagnostics.omitted,guidanceSubmitted:guide?.submitted??0,recoveryProcessed:recovery?.processed??0,recoveryStatus,desktopAlarm}));
  if(recoveryStatus==='failed'&&process.argv.includes('--once'))process.exitCode=1;
}
do{
  try{await check();}catch{if(!stopping){console.error(JSON.stringify({at:new Date().toISOString(),error:'monitor_check_failed',phase}));if(process.argv.includes('--once'))process.exitCode=1;}}
  if(process.argv.includes('--once')||stopping)break;
  for(let i=0;i<cfg.intervalSeconds&&!stopping;i++)await new Promise(r=>setTimeout(r,1000));
}while(!stopping);
