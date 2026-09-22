import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as dotenv from "dotenv";
import { CONFIG_DIR, CONFIG_FILE, SECRETS_FILE, PROVIDER_PRESETS, saveConfig } from "./config.js";
import { TASK_CATEGORIES } from "./router.js";
import { detectWorkers } from "./workers.js";
import type { RotoxyConfig, WorkerProfile } from "./types.js";

const root=process.env.ROTOXY_DIR||process.cwd();
const oldEnv=path.join(root,".env");
const parsed=fs.existsSync(oldEnv)?dotenv.parse(fs.readFileSync(oldEnv)):{};
const keys=(parsed.API_KEYS||"").split(",").map(x=>x.trim()).filter(Boolean);
if(!keys.length)throw new Error("No legacy API_KEYS found to migrate.");

fs.mkdirSync(CONFIG_DIR,{recursive:true,mode:0o700});
const secretLines=["# ROTOXY provider secrets. Never commit this file."];
const accounts=keys.map((key,i)=>{
  const secret=`ROTOXY_OLLAMA_ACCOUNT_${i+1}`;
  secretLines.push(`${secret}=${key}`);
  return {id:`account-${i+1}`,name:`Account ${i+1}`,secret,enabled:true};
});
fs.writeFileSync(SECRETS_FILE,secretLines.join("\n")+"\n",{mode:0o600});

let exposure:"serve"|"funnel"|"none"="funnel";
const oldRuntime=path.join(os.homedir(),".config","rotoxy","config.env");
if(fs.existsSync(oldRuntime)){
  const r=dotenv.parse(fs.readFileSync(oldRuntime));
  if(["serve","funnel","none"].includes(r.ROTOXY_EXPOSURE||""))exposure=r.ROTOXY_EXPOSURE as any;
}

const profiles:Record<string,WorkerProfile>={};
for(const w of detectWorkers().filter(x=>x.detected&&x.automation==="supported")){
  profiles[w.adapter]={id:w.adapter,label:w.label,adapter:w.adapter as any,command:w.command,enabled:true,timeoutSeconds:900};
}
const taskMappings=Object.fromEntries(TASK_CATEGORIES.map(([id])=>[id,null]));
const config:RotoxyConfig={
  version:2,
  listen:{host:"127.0.0.1",port:Number(parsed.SERVICE_PORT||2025)},
  security:{tokenFile:"~/.config/rotoxy/token"},
  exposure:{mode:exposure,layout:"single",servicePrefix:"rotoxy"},
  defaultPool:"ollama",
  providers:{
    ollama:{id:"ollama",...structuredClone(PROVIDER_PRESETS.ollama),accounts,enabled:true}
  },
  pools:{
    ollama:{id:"ollama",label:"Ollama Cloud accounts",type:"provider",strategy:"round-robin",provider:"ollama",enabled:true}
  },
  routers:{
    task:{enabled:false,fallbackPool:"ollama",mappings:taskMappings},
    difficulty:{enabled:false,fallbackPool:"ollama",mappings:{easy:null,medium:null,hard:null}},
    autoPolicy:"task-then-difficulty"
  },
  workers:{
    profiles,
    pools:{
      subscriptions:{id:"subscriptions",label:"OAuth/subscription CLI workers",strategy:"round-robin",workers:Object.keys(profiles)}
    }
  }
};
saveConfig(config);
console.log(`Migrated ${keys.length} Ollama account(s) to ROTOXY v2 without printing secrets.`);
console.log(`Detected ${Object.keys(profiles).length} supported local agent CLI worker(s).`);
console.log(`Config: ${CONFIG_FILE}`);
console.log(`Secrets: ${SECRETS_FILE}`);
