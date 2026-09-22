import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import type { RotoxyConfig, WorkerProfile } from "./types.js";
import { CONFIG_DIR, STATE_DIR } from "./config.js";

export const KNOWN_WORKERS = [
  {adapter:"codex",command:"codex",label:"OpenAI Codex CLI",oauth:true},
  {adapter:"gemini",command:"gemini",label:"Google Gemini CLI",oauth:true},
  {adapter:"claude",command:"claude",label:"Anthropic Claude Code",oauth:true},
  {adapter:"copilot",command:"copilot",label:"GitHub Copilot CLI",oauth:true},
  {adapter:"agy",command:"agy",label:"AGY",oauth:true},
  {adapter:"opencode",command:"opencode",label:"OpenCode",oauth:false}
] as const;

function which(command:string){
  const r=spawnSync(process.platform==="win32"?"where":"which",[command],{encoding:"utf8"});
  return r.status===0 ? r.stdout.trim().split(/\r?\n/)[0] : "";
}
export function detectWorkers(){
  return KNOWN_WORKERS.map(w=>({...w,path:which(w.command),detected:!!which(w.command),automation:w.adapter==="opencode"?"detected; adapter not enabled by default":"supported"}));
}

export function detectDesktopApps(){
  const dirs=[path.join(os.homedir(),".local","share","applications"),"/usr/share/applications"];
  const patterns=[
    {id:"chatgpt-desktop",label:"ChatGPT Desktop",re:/chatgpt/i},
    {id:"claude-desktop",label:"Claude Desktop",re:/anthropic.*claude|claude(?!-code)/i},
    {id:"antigravity-ide",label:"Antigravity IDE",re:/antigravity/i},
    {id:"cursor",label:"Cursor",re:/cursor/i},
    {id:"windsurf",label:"Windsurf",re:/windsurf/i}
  ];
  const found=new Map<string,{id:string,label:string,desktopFile:string,automation:string}>();
  for(const dir of dirs){
    if(!fs.existsSync(dir))continue;
    for(const name of fs.readdirSync(dir)){
      if(!name.endsWith(".desktop"))continue;
      for(const p of patterns){
        if(p.re.test(name)&&!found.has(p.id)) found.set(p.id,{id:p.id,label:p.label,desktopFile:path.join(dir,name),automation:"detected; no safe headless adapter"});
      }
    }
  }
  return [...found.values()];
}

function workerInvocation(profile:WorkerProfile,prompt:string,cwd?:string){
  const extra=profile.args||[];
  switch(profile.adapter){
    case "codex":
      return {args:["exec","--skip-git-repo-check","-s","read-only",...extra,"-"],stdin:prompt};
    case "gemini":
      return {args:[...extra,"-p",prompt,"--output-format","text"],stdin:""};
    case "claude":
      return {args:[...extra,"--permission-mode","plan","-p",prompt,"--output-format","text"],stdin:""};
    case "copilot":
      return {args:[...extra,"-p",prompt],stdin:""};
    case "agy":
      return {args:[...extra,"--mode","plan","-p",prompt,"--output-format","text"],stdin:""};
    case "opencode":
      return {args:[...extra,"run",prompt],stdin:""};
    default:
      return {args:[...extra,prompt],stdin:""};
  }
}

export async function runWorker(profile:WorkerProfile,prompt:string,overrideCwd?:string){
  if(profile.enabled===false)throw new Error(`Worker "${profile.id}" is disabled`);
  const command=profile.command;
  if(!which(command))throw new Error(`Worker command not found: ${command}`);
  const inv=workerInvocation(profile,prompt,overrideCwd);
  const cwd=overrideCwd||profile.cwd||process.cwd();
  const tokenPath=path.join(CONFIG_DIR,"token");
  const gatewayToken=fs.existsSync(tokenPath)?fs.readFileSync(tokenPath,"utf8").trim():"";
  const env={...process.env,...(gatewayToken?{ROTOXY_CLIENT_TOKEN:gatewayToken}:{}),...(profile.env||{})};
  const timeoutMs=(profile.timeoutSeconds||900)*1000;
  return await new Promise<{worker:string,code:number,stdout:string,stderr:string,durationMs:number}>((resolve,reject)=>{
    const start=Date.now();
    const child=spawn(command,inv.args,{cwd,env,stdio:["pipe","pipe","pipe"]});
    let stdout="",stderr="";
    child.stdout.on("data",d=>stdout+=d.toString());
    child.stderr.on("data",d=>stderr+=d.toString());
    if(inv.stdin){child.stdin.write(inv.stdin);child.stdin.end();}else child.stdin.end();
    const timer=setTimeout(()=>{child.kill("SIGTERM");setTimeout(()=>child.kill("SIGKILL"),2000).unref();},timeoutMs);
    child.on("error",reject);
    child.on("close",code=>{clearTimeout(timer);resolve({worker:profile.id,code:code??1,stdout:stdout.trim(),stderr:stderr.trim(),durationMs:Date.now()-start});});
  });
}

const CURSOR_FILE=path.join(STATE_DIR,"worker-cursors.json");
function chooseWorker(config:RotoxyConfig,poolId:string){
  const pool=config.workers.pools[poolId];
  if(!pool)throw new Error(`Unknown worker pool "${poolId}"`);
  const ids=pool.workers.filter(id=>config.workers.profiles[id]?.enabled!==false);
  if(!ids.length)throw new Error(`Worker pool "${poolId}" has no enabled workers`);
  let cursors:Record<string,number>={};
  try{cursors=JSON.parse(fs.readFileSync(CURSOR_FILE,"utf8"));}catch{}
  let index=0;
  if(pool.strategy==="random")index=Math.floor(Math.random()*ids.length);
  else if(pool.strategy==="failover")index=0;
  else {index=(cursors[poolId]||0)%ids.length;cursors[poolId]=(index+1)%ids.length;}
  fs.mkdirSync(STATE_DIR,{recursive:true,mode:0o700});
  fs.writeFileSync(CURSOR_FILE,JSON.stringify(cursors,null,2)+"\n",{mode:0o600});
  return config.workers.profiles[ids[index]];
}

export async function delegate(config:RotoxyConfig,opts:{worker?:string,pool?:string,prompt:string,cwd?:string}){
  let profile:WorkerProfile|undefined;
  if(opts.worker)profile=config.workers.profiles[opts.worker];
  else profile=chooseWorker(config,opts.pool||"subscriptions");
  if(!profile)throw new Error(`Unknown worker "${opts.worker}"`);
  return runWorker(profile,opts.prompt,opts.cwd);
}

export async function fanout(config:RotoxyConfig,opts:{pool:string,prompt:string,cwd?:string}){
  const pool=config.workers.pools[opts.pool];
  if(!pool)throw new Error(`Unknown worker pool "${opts.pool}"`);
  const profiles=pool.workers.map(id=>config.workers.profiles[id]).filter(Boolean).filter(p=>p.enabled!==false);
  return Promise.all(profiles.map(profile=>runWorker(profile,opts.prompt,opts.cwd).catch((e:any)=>({worker:profile.id,code:1,stdout:"",stderr:e.message,durationMs:0}))));
}
