import fs from "node:fs";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { CONFIG_DIR, CONFIG_FILE, PROVIDER_PRESETS, SECRETS_FILE, saveConfig } from "./config.js";
import { TASK_CATEGORIES } from "./router.js";
import { detectWorkers } from "./workers.js";
import type { RotoxyConfig, WorkerProfile } from "./types.js";

const rl=readline.createInterface({input,output});
const C={reset:"\x1b[0m",bold:"\x1b[1m",green:"\x1b[32m",cyan:"\x1b[36m",dim:"\x1b[2m"};
const p=(c:string,s:string)=>process.env.NO_COLOR?s:c+s+C.reset;

async function choose(title:string,items:{id:string,label:string}[],def=1){
  console.log("\n"+p(C.bold,title));
  items.forEach((x,i)=>console.log(`  ${i+1}) ${x.label}`));
  const ans=(await rl.question(`Choose [${def}]: `)).trim();
  const n=ans?Number(ans):def;
  return items[Math.max(0,Math.min(items.length-1,n-1))].id;
}
function slug(s:string){return s.toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"");}
function secretName(provider:string,n:number){return `ROTOXY_${provider.toUpperCase().replace(/[^A-Z0-9]/g,"_")}_ACCOUNT_${n}`;}

async function main(){
  if(fs.existsSync(CONFIG_FILE)){
    console.log("ROTOXY is already configured. Run: rotoxy configure");
    return;
  }
  console.log(p(C.bold,"ROTOXY first-run setup"));
  console.log("Providers contain accounts. Pools rotate interchangeable targets. Routes decide which pool receives a request.");

  const presetIds=Object.keys(PROVIDER_PRESETS);
  const preset=await choose("Initial provider",presetIds.map(id=>({id,label:PROVIDER_PRESETS[id].label})),1);
  const base=structuredClone(PROVIDER_PRESETS[preset]);
  const id=slug((await rl.question(`Provider ID [${preset}]: `)).trim()||preset);

  console.log("\nPaste provider API keys. Leave the next Account prompt blank to finish.");
  const accounts:any[]=[];const secretLines=["# ROTOXY provider secrets. Never commit this file."];
  for(let n=1;;n++){
    const key=(await rl.question(`Account ${n} API key: `)).trim();
    if(!key)break;
    const secret=secretName(id,n);
    secretLines.push(`${secret}=${key}`);
    accounts.push({id:`account-${n}`,name:`Account ${n}`,secret,enabled:true});
  }
  if(!accounts.length)throw new Error("At least one provider account is required.");

  const exposure=await choose("Network exposure",[
    {id:"serve",label:"Tailscale Serve — private to your tailnet (recommended)"},
    {id:"funnel",label:"Tailscale Funnel — public HTTPS protected by ROTOXY token"},
    {id:"none",label:"Localhost only"}
  ],1);

  const profiles:Record<string,WorkerProfile>={};
  for(const w of detectWorkers().filter(x=>x.detected&&x.automation==="supported")){
    profiles[w.adapter]={id:w.adapter,label:w.label,adapter:w.adapter as any,command:w.command,enabled:true,timeoutSeconds:900};
  }

  fs.mkdirSync(CONFIG_DIR,{recursive:true,mode:0o700});
  fs.writeFileSync(SECRETS_FILE,secretLines.join("\n")+"\n",{mode:0o600});
  const config:RotoxyConfig={
    version:2,
    listen:{host:"127.0.0.1",port:2025},
    security:{tokenFile:"~/.config/rotoxy/token"},
    exposure:{mode:exposure as any,layout:"single",servicePrefix:"rotoxy"},
    defaultPool:id,
    providers:{[id]:{id,...base,accounts,enabled:true}},
    pools:{[id]:{id,label:`${base.label} accounts`,type:"provider",strategy:"round-robin",provider:id,enabled:true}},
    routers:{
      task:{enabled:false,fallbackPool:id,mappings:Object.fromEntries(TASK_CATEGORIES.map(([k])=>[k,null]))},
      difficulty:{enabled:false,fallbackPool:id,mappings:{easy:null,medium:null,hard:null}},
      autoPolicy:"task-then-difficulty"
    },
    workers:{
      profiles,
      pools:{subscriptions:{id:"subscriptions",label:"OAuth/subscription CLI workers",strategy:"round-robin",workers:Object.keys(profiles)}}
    },
    mcp:{servers:{},assignments:{}}
  };
  saveConfig(config);

  console.log("\n"+p(C.green,"✓")+" Configuration written.");
  console.log(`  Provider: ${id} • ${accounts.length} rotating account(s)`);
  console.log(`  Exposure: ${exposure} / single`);
  console.log(`  Agent CLIs detected: ${Object.keys(profiles).length}`);
  console.log("\nRun 'rotoxy configure' later for additional providers, federated pools and smart routers.");
}
main().catch(e=>{console.error("ROTOXY: "+e.message);process.exitCode=1;}).finally(()=>rl.close());
