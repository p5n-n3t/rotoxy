import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { CONFIG_FILE, PROVIDER_PRESETS, SECRETS_FILE, loadConfig, saveConfig } from "./config.js";
import { TASK_CATEGORIES } from "./router.js";
import { detectWorkers } from "./workers.js";
import type { AccountConfig, PoolConfig, RotoxyConfig, SmartTarget, WorkerProfile } from "./types.js";

const C={reset:"\x1b[0m",bold:"\x1b[1m",dim:"\x1b[2m",green:"\x1b[32m",yellow:"\x1b[33m",red:"\x1b[31m",cyan:"\x1b[36m",blue:"\x1b[34m"};
const paint=(c:string,s:string)=>process.env.NO_COLOR?s:c+s+C.reset;
const ok=(s:string)=>console.log(paint(C.green,"✓ ")+s);
const note=(s:string)=>console.log(paint(C.cyan,"• ")+s);
const warn=(s:string)=>console.log(paint(C.yellow,"! ")+s);

function parseSecrets(){
  const map:Record<string,string>={};
  if(!fs.existsSync(SECRETS_FILE))return map;
  for(const line of fs.readFileSync(SECRETS_FILE,"utf8").split(/\r?\n/)){
    if(!line||line.trim().startsWith("#")||!line.includes("="))continue;
    const i=line.indexOf("=");map[line.slice(0,i).trim()]=line.slice(i+1);
  }
  return map;
}
function writeSecrets(map:Record<string,string>){
  fs.mkdirSync(path.dirname(SECRETS_FILE),{recursive:true,mode:0o700});
  const lines=["# ROTOXY provider secrets. Never commit this file."];
  for(const key of Object.keys(map).sort())lines.push(`${key}=${map[key]}`);
  fs.writeFileSync(SECRETS_FILE,lines.join("\n")+"\n",{mode:0o600});
  fs.chmodSync(SECRETS_FILE,0o600);
}
const slug=(s:string)=>s.toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"");
const secretName=(provider:string,n:number)=>`ROTOXY_${provider.toUpperCase().replace(/[^A-Z0-9]/g,"_")}_ACCOUNT_${n}`;

function summary(config:RotoxyConfig){
  console.log(paint(C.bold,"ROTOXY configuration"));
  console.log(`  Default pool: ${paint(C.cyan,config.defaultPool)}`);
  console.log(`  Exposure:     ${config.exposure.mode} / ${config.exposure.layout}`);
  console.log(`  Providers:    ${Object.keys(config.providers).length}`);
  for(const p of Object.values(config.providers)){
    const pool=Object.values(config.pools).find(x=>x.type==="provider"&&x.provider===p.id);
    console.log(`    ${paint(C.bold,p.id.padEnd(14))} ${p.accounts.length} account(s) • ${p.wire} • ${p.policy?.freeOnly?paint(C.green,"free-only"):"standard"}${pool&&config.defaultPool===pool.id?" • "+paint(C.green,"default"):""}`);
  }
  const fed=Object.values(config.pools).filter(p=>p.type==="federated");
  console.log(`  Federated pools: ${fed.length}`);
  console.log(`  Task router:      ${config.routers.task.enabled?paint(C.green,"on"):paint(C.dim,"off")}`);
  console.log(`  Difficulty router:${config.routers.difficulty.enabled?paint(C.green," on"):paint(C.dim," off")}`);
  console.log(`  Agent workers:    ${Object.keys(config.workers.profiles).length}`);
}

async function choose(rl:readline.Interface,title:string,items:{id:string,label:string}[],allowBack=true){
  console.log("\n"+paint(C.bold,title));
  items.forEach((x,i)=>console.log(`  ${i+1}) ${x.label} ${paint(C.dim,"("+x.id+")")}`));
  if(allowBack)console.log("  0) Back");
  const ans=(await rl.question("> ")).trim();
  if(allowBack&&ans==="0")return null;
  const n=Number(ans);
  if(Number.isInteger(n)&&n>=1&&n<=items.length)return items[n-1].id;
  const direct=items.find(x=>x.id===ans);
  return direct?.id||null;
}

async function addProvider(rl:readline.Interface,config:RotoxyConfig){
  const presets=Object.entries(PROVIDER_PRESETS).map(([id,p])=>({id,label:p.label}));
  presets.push({id:"generic",label:"Generic/custom provider"});
  const presetId=await choose(rl,"Choose provider",presets);
  if(!presetId)return;
  const defaultId=presetId;
  const entered=(await rl.question(`Provider ID [${defaultId}]: `)).trim();
  const id=slug(entered||defaultId);
  if(!id)return;
  if(config.providers[id]&&!((await rl.question(`Provider "${id}" exists. Replace it? [y/N]: `)).trim().toLowerCase()==="y"))return;

  let base:any;
  if(presetId==="generic"){
    const baseUrl=(await rl.question("Base URL: ")).trim();
    const header=(await rl.question("Authentication header [Authorization]: ")).trim()||"Authorization";
    const prefix=(await rl.question("Authentication prefix [Bearer ]: "))||"Bearer ";
    base={label:id,adapter:"generic",wire:"openai",baseUrl,auth:{kind:"bearer",header,prefix},modelListPath:"/v1/models"};
  }else base=structuredClone(PROVIDER_PRESETS[presetId]);

  console.log("\nPaste API keys. A blank entry finishes the account list.");
  const secrets=parseSecrets();
  const accounts:AccountConfig[]=[];
  for(let n=1;;n++){
    const key=(await rl.question(`Account ${n} API key: `)).trim();
    if(!key)break;
    const env=secretName(id,n);
    secrets[env]=key;
    accounts.push({id:`account-${n}`,name:`Account ${n}`,secret:env,enabled:true});
  }
  if(!accounts.length){warn("No accounts added.");return;}
  writeSecrets(secrets);
  config.providers[id]={id,...base,accounts,enabled:true};
  config.pools[id]={id,label:`${base.label} accounts`,type:"provider",strategy:"round-robin",provider:id,enabled:true};
  saveConfig(config);
  ok(`Added ${id} with ${accounts.length} rotating account(s).`);
}

async function defaultPoolMenu(rl:readline.Interface,config:RotoxyConfig){
  const id=await choose(rl,"Choose the default pool",Object.values(config.pools).filter(p=>p.enabled!==false).map(p=>({id:p.id,label:`${p.label} [${p.type}]`})));
  if(!id)return;
  config.defaultPool=id;saveConfig(config);ok(`Default pool is now ${id}. Existing ROTOXY URL stays unchanged.`);
}

async function federatedPool(rl:readline.Interface,config:RotoxyConfig){
  console.log("\n"+paint(C.bold,"Federated same-model pool"));
  note("Use this when equivalent model(s) are available through multiple OpenAI-compatible providers.");
  note("Provider-specific model IDs may differ; map each provider to its own model ID.");
  const id=slug((await rl.question("Pool name: ")).trim());
  if(!id)return;
  const strategy=(await rl.question("Strategy [round-robin/random/failover] (round-robin): ")).trim()||"round-robin";
  const targets:any[]=[];
  const providers=Object.values(config.providers).filter(p=>p.enabled!==false);
  while(true){
    const pid=await choose(rl,"Add target provider (blank/0 finishes)",providers.map(p=>({id:p.id,label:`${p.label} • ${p.wire}`})));
    if(!pid)break;
    const model=(await rl.question("Model ID on this provider: ")).trim();
    if(!model){warn("Model is required for a federated target.");continue;}
    if(config.providers[pid].adapter==="openrouter"&&config.providers[pid].policy?.freeOnly&&model!=="openrouter/free"&&!model.endsWith(":free")){
      warn("OpenRouter is free-only in ROTOXY. Use openrouter/free or a :free model.");continue;
    }
    targets.push({provider:pid,model});
    if((await rl.question("Add another provider target? [Y/n]: ")).trim().toLowerCase()==="n")break;
  }
  if(targets.length<2){warn("A federated pool needs at least two targets.");return;}
  const wires=new Set(targets.map(t=>config.providers[t.provider].wire));
  if(wires.size>1){warn("Those providers use incompatible API wire formats. Choose targets that share the same wire protocol.");return;}
  config.pools[id]={id,label:id,type:"federated",strategy:strategy as any,targets,enabled:true};
  saveConfig(config);ok(`Created federated pool ${id} with ${targets.length} provider targets.`);
}

async function smartRouter(rl:readline.Interface,config:RotoxyConfig,kind:"task"|"difficulty"){
  const router=config.routers[kind];
  router.enabled=true;
  const keys=kind==="task"?TASK_CATEGORIES.map(([id,desc])=>({id,label:`${id} — ${desc}`})):[{id:"easy",label:"Easy / routine"},{id:"medium",label:"Medium / multi-step"},{id:"hard",label:"Hard / deep reasoning"}];
  while(true){
    const key=await choose(rl,`${kind==="task"?"Task":"Difficulty"} router: choose a class to map`,keys);
    if(!key)break;
    const pool=await choose(rl,"Choose destination pool",Object.values(config.pools).map(p=>({id:p.id,label:`${p.label} [${p.type}]`})));
    if(!pool)continue;
    const model=(await rl.question("Model override (blank = pool/provider default or incoming model): ")).trim();
    router.mappings[key]={pool,...(model?{model}:{})};
    saveConfig(config);ok(`Mapped ${key} → ${pool}${model?"/"+model:""}`);
  }
  saveConfig(config);
}

async function exposureMenu(rl:readline.Interface,config:RotoxyConfig){
  const mode=await choose(rl,"Network exposure",[
    {id:"serve",label:"Tailscale Serve • tailnet-only (recommended)"},
    {id:"funnel",label:"Tailscale Funnel • public HTTPS + ROTOXY token"},
    {id:"none",label:"Localhost only"}
  ]);
  if(!mode)return;
  let layout:"single"|"services"="single";
  if(mode==="serve"){
    const l=await choose(rl,"Endpoint layout",[
      {id:"single",label:"One stable ROTOXY URL • simplest"},
      {id:"services",label:"Named Tailscale Service URL per provider/pool • advanced"}
    ]);
    if(l)layout=l as any;
  }
  config.exposure.mode=mode as any;config.exposure.layout=layout;saveConfig(config);
  ok(`Exposure set to ${mode}/${layout}. Run rotoxy restart to apply Tailscale exposure changes.`);
}

function syncWorkers(config:RotoxyConfig){
  const found=detectWorkers().filter(w=>w.detected&&w.automation==="supported");
  for(const w of found){
    if(!config.workers.profiles[w.adapter]){
      config.workers.profiles[w.adapter]={
        id:w.adapter,label:w.label,adapter:w.adapter as any,command:w.command,enabled:true,timeoutSeconds:900
      };
    }
  }
  const ids=found.map(w=>w.adapter).filter(id=>config.workers.profiles[id]);
  config.workers.pools.subscriptions={id:"subscriptions",label:"OAuth/subscription CLI workers",strategy:"round-robin",workers:ids};
  saveConfig(config);
  return found;
}

async function workersMenu(config:RotoxyConfig){
  const found=syncWorkers(config);
  ok(`Synced ${found.length} supported local agent CLI(s).`);
  for(const w of detectWorkers())console.log(`  ${w.detected?paint(C.green,"●"):paint(C.dim,"○")} ${w.label.padEnd(24)} ${w.detected?w.path:"not installed"}`);
  note("ROTOXY invokes official CLIs; it does not copy or replay their OAuth tokens.");
}

async function interactive(){
  const rl=readline.createInterface({input,output});
  try{
    while(true){
      const config=loadConfig();
      console.log("\n");summary(config);
      const action=await choose(rl,"Configuration",[
        {id:"providers",label:"Add or replace a provider + rotating accounts"},
        {id:"default",label:"Switch default provider/pool without changing URL"},
        {id:"federated",label:"Create a same-model cross-provider pool"},
        {id:"task",label:"Configure task-category smart routing"},
        {id:"difficulty",label:"Configure easy / medium / hard routing"},
        {id:"exposure",label:"Configure Tailscale exposure"},
        {id:"workers",label:"Detect and sync OAuth/subscription agent CLIs"}
      ]);
      if(!action)break;
      const cfg=loadConfig();
      if(action==="providers")await addProvider(rl,cfg);
      if(action==="default")await defaultPoolMenu(rl,cfg);
      if(action==="federated")await federatedPool(rl,cfg);
      if(action==="task")await smartRouter(rl,cfg,"task");
      if(action==="difficulty")await smartRouter(rl,cfg,"difficulty");
      if(action==="exposure")await exposureMenu(rl,cfg);
      if(action==="workers")await workersMenu(cfg);
    }
  }finally{rl.close();}
}

async function main(){
  const cmd=process.argv[2]||"menu";
  if(cmd==="menu"){await interactive();return;}
  const config=loadConfig();
  if(cmd==="summary"){summary(config);return;}
  if(cmd==="provider-use"){
    const id=process.argv[3];if(!id)throw new Error("provider-use requires a provider ID");
    const pool=Object.values(config.pools).find(p=>p.type==="provider"&&p.provider===id);
    if(!pool)throw new Error(`No provider pool found for "${id}"`);
    config.defaultPool=pool.id;saveConfig(config);ok(`Default provider switched to ${id}. URL unchanged.`);return;
  }
  if(cmd==="workers-sync"){await workersMenu(config);return;}
  throw new Error(`Unknown admin command "${cmd}"`);
}
main().catch(e=>{console.error(paint(C.red,"ROTOXY: "+e.message));process.exit(1);});
