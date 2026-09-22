import fs from "node:fs";
import { loadConfig } from "./config.js";

const C={reset:"\x1b[0m",bold:"\x1b[1m",dim:"\x1b[2m",green:"\x1b[32m",yellow:"\x1b[33m",red:"\x1b[31m",cyan:"\x1b[36m",blue:"\x1b[34m",magenta:"\x1b[35m"};
const paint=(c:string,s:any)=>process.env.NO_COLOR?String(s):c+String(s)+C.reset;
const read=()=>fs.readFileSync(0,"utf8").trim();
const fmt=(n:number)=>new Intl.NumberFormat("en-US",{notation:n>=1_000_000?"compact":"standard",maximumFractionDigits:1}).format(n||0);

function models(d:any){
  const providers=d.providers||[];
  console.log(paint(C.bold,`ROTOXY models • ${d.uniqueModels?.length||0} unique`));
  for(const p of providers){
    const good=(p.accounts||[]).filter((a:any)=>a.status>0&&a.status<400).length;
    console.log(`  ${paint(C.cyan,p.label)}  ${good}/${p.accounts?.length||0} accounts responding  •  ${p.models?.length||0} models${p.freeOnly?"  •  "+paint(C.green,"FREE ONLY"):""}`);
  }
  console.log("");
  for(const m of d.uniqueModels||[]){
    const badges=(m.providers||[]).map((p:string)=>paint(C.dim,`[${p}]`)).join(" ");
    console.log(`  ${paint(C.green,"•")} ${m.name} ${badges}`);
  }
}

function usage(d:any){
  const config=loadConfig();
  console.log(paint(C.bold,"ROTOXY usage"));
  let any=false;
  for(const [pid,p0] of Object.entries(d.providers||{})){
    const p:any=p0;
    const provider=config.providers[pid];
    console.log("\n"+paint(C.cyan,provider?.label||pid));
    for(const [aid,a0] of Object.entries(p.accounts||{})){
      const a:any=a0;
      any=true;
      const name=provider?.accounts.find(x=>x.id===aid)?.name||aid;
      console.log(`  ${paint(C.bold,name)} • ${fmt(a.totalTokens)} tokens • ${a.requests} requests • ${a.errors} errors • ${a.rateLimits} rate limits`);
      const models=Object.entries(a.models||{}).sort((x:any,y:any)=>y[1].totalTokens-x[1].totalTokens);
      for(const [model,m0] of models){const m:any=m0; console.log(`    ${paint(C.dim,"↳")} ${model}: ${fmt(m.totalTokens)} tokens / ${m.requests} req`);}
    }
  }
  if(!any)console.log("  No routed requests recorded yet.");
  const routes=Object.entries(d.routes||{});
  if(routes.length){
    console.log("\n"+paint(C.bold,"Pools"));
    for(const [id,r0] of routes){const r:any=r0; console.log(`  ${id}: ${r.requests} requests • ${r.errors} errors`);}
  }
}

function health(d:any){
  console.log(`${d.ok?paint(C.green,"● ONLINE"):paint(C.red,"● OFFLINE")}  ROTOXY v${d.version||"?"}`);
  console.log(`  Providers: ${d.providers}  •  Pools: ${d.pools}  •  Default: ${paint(C.cyan,d.defaultPool)}`);
}

function config(d:any){
  console.log(paint(C.bold,"ROTOXY routing"));
  console.log(`  Default pool: ${paint(C.cyan,d.defaultPool)}`);
  console.log(`  Exposure: ${d.exposure?.mode} / ${d.exposure?.layout}`);
  console.log("\n"+paint(C.bold,"Providers"));
  for(const p of d.providers||[])console.log(`  ${paint(C.green,"●")} ${p.id.padEnd(14)} ${p.accounts} account(s) • ${p.wire}${p.freeOnly?" • "+paint(C.green,"free-only"):""}`);
  console.log("\n"+paint(C.bold,"Pools"));
  for(const p of d.pools||[])console.log(`  ${paint(C.blue,"◆")} ${p.id.padEnd(18)} ${p.type} • ${p.strategy}`);
  console.log("\n"+paint(C.bold,"Smart routers"));
  console.log(`  Task:       ${d.routers?.task?.enabled?paint(C.green,"ON"):paint(C.dim,"OFF")}`);
  console.log(`  Difficulty: ${d.routers?.difficulty?.enabled?paint(C.green,"ON"):paint(C.dim,"OFF")}`);
  console.log(`  Auto policy: ${d.routers?.autoPolicy}`);
}

function classify(d:any){
  console.log(paint(C.bold,"ROTOXY classification"));
  console.log(`  Task:       ${paint(C.cyan,d.task)}`);
  console.log(`  Difficulty: ${paint(d.difficulty==="hard"?C.red:d.difficulty==="medium"?C.yellow:C.green,d.difficulty)}`);
  for(const r of d.reasons||[])console.log(`  ${paint(C.dim,"• "+r)}`);
}

const mode=process.argv[2]||"raw";
const raw=read();
if(!raw){process.exit(0);}
let d:any;
try{d=JSON.parse(raw);}catch{console.log(raw);process.exit(0);}
if(mode==="models")models(d);
else if(mode==="usage")usage(d);
else if(mode==="health")health(d);
else if(mode==="config")config(d);
else if(mode==="classify")classify(d);
else console.log(JSON.stringify(d,null,2));
