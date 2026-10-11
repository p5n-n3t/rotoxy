#!/usr/bin/env node
/** Read-only LightSprint observation plus durable local guidance. No cloud chat/launch. */
import { readFile, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StateStore } from '../dist/store.js';
import { serverMessages } from '../dist/jsonrpc-wire.js';

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
const store=new StateStore();
let stopping=false;
process.on('SIGTERM',()=>{stopping=true;});process.on('SIGINT',()=>{stopping=true;});
function python(command,item){return new Promise((yes,no)=>{
  const args=['-m','snooze.guidance','--db',cfg.inboxDb,command];
  if(command==='guide')args.push('--pool-config',cfg.poolConfig,'--pool-db',cfg.poolDb);
  const p=spawn('/usr/bin/python3',args,{cwd:root,env:{...process.env,PYTHONPATH:resolve(root,'supervisor')},stdio:['pipe','pipe','ignore']});
  let out='',size=0;const timer=setTimeout(()=>p.kill('SIGKILL'),20000);
  p.stdout.on('data',b=>{size+=b.length;if(size>16384)p.kill('SIGKILL');else out+=b;});
  p.on('error',()=>{clearTimeout(timer);no(Error('guidance_unavailable'));});
  p.on('exit',code=>{clearTimeout(timer);if(code!==0)no(Error('guidance_failed'));else{try{yes(JSON.parse(out));}catch{no(Error('guidance_invalid_receipt'));}}});
  p.stdin.on('error',()=>{});p.stdin.end(item?JSON.stringify(item):'');
});}
async function observation(worker,state){
  const account=state.accounts.find(a=>a.id===worker.accountId);
  if(!account)return{state:'unavailable'};
  // The only remote paths are initialize and this exact bound status endpoint.
  const token=await store.revealToken(account);let session;let id=0;
  async function rpc(method,params){
    const callId=++id;
    const r=await fetch(state.config.upstreamUrl,{method:'POST',headers:{authorization:'Bearer '+token,accept:'application/json, text/event-stream','content-type':'application/json',...(session?{'mcp-session-id':session,'mcp-protocol-version':'2025-06-18'}:{})},body:JSON.stringify({jsonrpc:'2.0',id:callId,method,params}),signal:AbortSignal.timeout(20000)});
    session=r.headers.get('mcp-session-id')||session;
    const body=await r.text();if(body.length>1024*1024)throw Error('response_limit');
    const value=serverMessages(r.headers.get('content-type'),body).find(x=>x.id===callId);
    if(!r.ok||!value||value.error||value.result?.isError)throw Error('status_unavailable');return value.result;
  }
  const init=await rpc('initialize',{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'token2oauth-readonly-monitor',version:'1'}});
  if(!init?.serverInfo)throw Error('initialize_failed');
  const result=await rpc('tools/call',{name:'lightsprint_api',arguments:{method:'GET',path:'/api/agent-sessions/'+worker.sessionId+'/status'}});
  const raw=JSON.parse(result.content.find(c=>c.type==='text').text);const s=raw.status;
  if(!s||s.sessionId!==worker.sessionId||s.isOwner!==true)return{state:'unavailable'};
  const allowed=['running','idle','failed','cancelled'];
  return{state:allowed.includes(s.sessionStatus)?s.sessionStatus:'unknown',...(safe(s.model)?{model:s.model}:{}),
    ...(Number.isSafeInteger(s.promptCount)&&s.promptCount>=0?{promptCount:s.promptCount}:{}),needsInput:!!s.parkedQuestion};
}
async function check(){
  const state=await store.load();let checked=0,errors=0;
  const registered=await python('registrations');
  const workers=[...cfg.workers,...(Array.isArray(registered?.workers)?registered.workers.filter(w=>
    ['id','project','owner','account_id','session_id'].every(k=>safe(w[k]))
  ).map(w=>({id:w.id,projectId:w.project,owner:w.owner,accountId:w.account_id,sessionId:w.session_id,job:w.project})):[])];
  const unique=[...new Map(workers.map(w=>[`${w.owner}:${w.job}:${w.sessionId}`,w])).values()];
  for(let i=0;i<unique.length&&!stopping;i+=3){
    await Promise.all(unique.slice(i,i+3).map(async worker=>{
      let o;try{o=await observation(worker,state);}catch{o={state:'unavailable'};errors++;}
      await python('observe',{worker:worker.id,observation:o,owner:worker.owner,job:worker.job});checked++;
    }));
  }
  const guide=cfg.guide===true?await python('guide'):undefined;
  console.log(JSON.stringify({at:new Date().toISOString(),checked,statusErrors:errors,guidanceSubmitted:guide?.submitted??0}));
}
do{
  try{await check();}catch{console.error(JSON.stringify({at:new Date().toISOString(),error:'monitor_check_failed'}));if(process.argv.includes('--once'))process.exitCode=1;}
  if(process.argv.includes('--once')||stopping)break;
  for(let i=0;i<cfg.intervalSeconds&&!stopping;i++)await new Promise(r=>setTimeout(r,1000));
}while(!stopping);
