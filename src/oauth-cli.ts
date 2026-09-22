import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { loadConfig, saveConfig } from "./config.js";
import type { WorkerProfile } from "./types.js";

const C={reset:"\x1b[0m",bold:"\x1b[1m",dim:"\x1b[2m",green:"\x1b[32m",yellow:"\x1b[33m",red:"\x1b[31m",cyan:"\x1b[36m"};
const color=(c:string,s:string)=>process.env.NO_COLOR?s:c+s+C.reset;
const slug=(s:string)=>s.toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"");
const exists=(cmd:string)=>{
  const r=spawnSync(process.platform==="win32"?"where":"which",[cmd],{encoding:"utf8"});
  return r.status===0;
};

type OAuthAdapter = "codex"|"gemini"|"copilot"|"claude"|"agy";

function isolatedProfile(adapter:OAuthAdapter,name:string){
  const base=path.join(os.homedir(),".config","rotoxy","oauth",adapter,slug(name));
  fs.mkdirSync(base,{recursive:true,mode:0o700});
  switch(adapter){
    case "codex":
      return {command:"codex",env:{CODEX_HOME:base},loginArgs:["login"],isolated:true};
    case "gemini":
      return {command:"gemini",env:{},loginArgs:[],isolated:false};
    case "copilot":
      return {command:"copilot",env:{COPILOT_HOME:base},loginArgs:["login"],isolated:true};
    case "claude":
      return {command:"claude",env:{},loginArgs:[],isolated:false};
    case "agy":
      return {command:"agy",env:{},loginArgs:[],isolated:false};
  }
}

function addToPool(config:any,id:string){
  const pool=config.workers.pools.subscriptions ||= {
    id:"subscriptions",label:"OAuth/subscription CLI workers",strategy:"round-robin",workers:[]
  };
  if(!pool.workers.includes(id))pool.workers.push(id);
}

function printList(){
  const config=loadConfig();
  console.log(color(C.bold,"ROTOXY OAuth/subscription workers"));
  const rows=Object.values(config.workers.profiles).filter((p:any)=>p.env?.CODEX_HOME||p.env?.COPILOT_HOME||["codex","gemini","copilot","claude","agy"].includes(p.adapter));
  if(!rows.length){console.log("  None configured.");return;}
  for(const p of rows as WorkerProfile[]){
    const isolated=!!(p.env?.CODEX_HOME||p.env?.COPILOT_HOME);
    console.log(`  ${color(C.green,"●")} ${p.id.padEnd(22)} ${p.adapter.padEnd(9)} ${isolated?color(C.cyan,"isolated profile"):color(C.dim,"current CLI session")}`);
  }
}

function add(adapter:OAuthAdapter,name:string){
  const profile=isolatedProfile(adapter,name);
  if(!exists(profile.command))throw new Error(`${profile.command} is not installed.`);
  const config=loadConfig();
  const id=slug(`${adapter}-${name}`);

  if(!profile.isolated){
    if(Object.values(config.workers.profiles).some((p:any)=>p.adapter===adapter&&p.id!==id)){
      throw new Error(`${adapter} does not have an official isolated config-home adapter wired into ROTOXY. Use its existing signed-in CLI as one worker, rather than copying OAuth credentials.`);
    }
    console.log(color(C.yellow,"This adapter uses the CLI's current signed-in session; ROTOXY will not copy its OAuth token."));
  }else{
    console.log(color(C.cyan,`Opening ${adapter} authentication for isolated profile "${name}"...`));
    console.log(color(C.dim,`State directory: ${Object.values(profile.env)[0]}`));
    const result=spawnSync(profile.command,profile.loginArgs,{
      env:{...process.env,...profile.env},
      stdio:"inherit"
    });
    if((result.status??1)!==0)throw new Error(`${adapter} authentication exited with code ${result.status}.`);
  }

  const worker:WorkerProfile={
    id,label:`${adapter} • ${name}`,adapter,command:profile.command,enabled:true,env:profile.env as Record<string,string>,timeoutSeconds:900
  };
  config.workers.profiles[id]=worker;
  addToPool(config,id);
  saveConfig(config);
  console.log(color(C.green,`✓ Added ${id} to the subscriptions worker pool.`));
}

function remove(id:string){
  const config=loadConfig();
  if(!config.workers.profiles[id])throw new Error(`Unknown worker profile "${id}".`);
  delete config.workers.profiles[id];
  for(const pool of Object.values(config.workers.pools)) pool.workers=pool.workers.filter(x=>x!==id);
  saveConfig(config);
  console.log(color(C.green,`✓ Removed ${id} from ROTOXY routing.`));
  console.log(color(C.dim,"The provider's OAuth authorization itself was not revoked."));
}

function help(){
  console.log(`ROTOXY OAuth/subscription profiles

  rotoxy oauth list
  rotoxy oauth add codex NAME
  rotoxy oauth add gemini NAME
  rotoxy oauth add copilot NAME
  rotoxy oauth add claude NAME
  rotoxy oauth add agy NAME
  rotoxy oauth remove WORKER_ID

Codex and Copilot can use isolated ROTOXY-owned config directories through their documented CODEX_HOME and COPILOT_HOME overrides.
Gemini CLI, Claude and AGY are registered through their current official CLI session unless you provide a custom wrapper; ROTOXY never copies or replays their OAuth tokens.`);
}

try{
  const cmd=process.argv[2]||"list";
  if(cmd==="list")printList();
  else if(cmd==="add"){
    const adapter=process.argv[3] as OAuthAdapter|undefined;
    const name=process.argv[4];
    if(!adapter||!name||!["codex","gemini","copilot","claude","agy"].includes(adapter))throw new Error("Usage: rotoxy oauth add codex|gemini|copilot|claude|agy NAME");
    add(adapter,name);
  }else if(cmd==="remove"){
    const id=process.argv[3];if(!id)throw new Error("Usage: rotoxy oauth remove WORKER_ID");remove(id);
  }else if(cmd==="help")help();
  else throw new Error(`Unknown oauth command "${cmd}"`);
}catch(e:any){
  console.error(color(C.red,"ROTOXY: "+e.message));process.exit(1);
}
