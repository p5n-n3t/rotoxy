import fs from "node:fs";
import path from "node:path";
import { STATE_DIR } from "./config.js";

export type TokenUsage = { input:number; output:number; total:number };

type ModelStats = {
  requests:number; inputTokens:number; outputTokens:number; totalTokens:number;
  errors:number; rateLimits:number;
};
type AccountStats = {
  requests:number; inputTokens:number; outputTokens:number; totalTokens:number;
  errors:number; rateLimits:number; lastUsedAt?:string; lastStatus?:number;
  models:Record<string,ModelStats>;
};
type ProviderStats = { accounts:Record<string,AccountStats> };
type RouteStats = { requests:number; errors:number; lastUsedAt?:string };
type UsageState = {
  version:2; createdAt:string; updatedAt:string;
  providers:Record<string,ProviderStats>;
  routes:Record<string,RouteStats>;
};

const FILE = path.join(STATE_DIR,"usage-v2.json");
const now = () => new Date().toISOString();
const blankAccount = ():AccountStats => ({requests:0,inputTokens:0,outputTokens:0,totalTokens:0,errors:0,rateLimits:0,models:{}});
const blankModel = ():ModelStats => ({requests:0,inputTokens:0,outputTokens:0,totalTokens:0,errors:0,rateLimits:0});

function load():UsageState {
  try { return JSON.parse(fs.readFileSync(FILE,"utf8")) as UsageState; }
  catch { return {version:2,createdAt:now(),updatedAt:now(),providers:{},routes:{}}; }
}
let state=load();
let timer:NodeJS.Timeout|undefined;

function saveSoon(){
  if(timer)return;
  timer=setTimeout(()=>{
    fs.mkdirSync(STATE_DIR,{recursive:true,mode:0o700});
    state.updatedAt=now();
    const tmp=FILE+".tmp";
    fs.writeFileSync(tmp,JSON.stringify(state,null,2)+"\n",{mode:0o600});
    fs.renameSync(tmp,FILE);
    timer=undefined;
  },150);
}

export function extractUsage(body:string):TokenUsage {
  let best:TokenUsage={input:0,output:0,total:0};
  const consider=(o:any)=>{
    if(!o||typeof o!=="object")return;
    let u:TokenUsage|null=null;
    if(Number.isFinite(o.prompt_eval_count)||Number.isFinite(o.eval_count)){
      const input=Number(o.prompt_eval_count||0),output=Number(o.eval_count||0);
      u={input,output,total:input+output};
    } else if(o.usage&&typeof o.usage==="object"){
      const input=Number(o.usage.prompt_tokens??o.usage.input_tokens??0);
      const output=Number(o.usage.completion_tokens??o.usage.output_tokens??0);
      const total=Number(o.usage.total_tokens??input+output);
      if(input||output||total)u={input,output,total};
    } else if(o.usageMetadata&&typeof o.usageMetadata==="object"){
      const input=Number(o.usageMetadata.promptTokenCount||0);
      const output=Number(o.usageMetadata.candidatesTokenCount||0);
      const total=Number(o.usageMetadata.totalTokenCount||input+output);
      if(input||output||total)u={input,output,total};
    }
    if(u&&u.total>=best.total)best=u;
  };
  try{consider(JSON.parse(body));}catch{}
  for(const raw of body.split(/\r?\n/)){
    let line=raw.trim();
    if(line.startsWith("data:"))line=line.slice(5).trim();
    if(!line||line==="[DONE]")continue;
    try{consider(JSON.parse(line));}catch{}
  }
  return best;
}

export function recordUsage(input:{
  providerId:string; accountId:string; model:string; poolId:string; status:number; tokens:TokenUsage;
}){
  const {providerId,accountId,model,poolId,status,tokens}=input;
  const p=state.providers[providerId] ||= {accounts:{}};
  const a=p.accounts[accountId] ||= blankAccount();
  const m=a.models[model||"unknown"] ||= blankModel();
  for(const x of [a,m]){
    x.requests++;x.inputTokens+=tokens.input;x.outputTokens+=tokens.output;x.totalTokens+=tokens.total;
    if(status>=400)x.errors++;
    if(status===429)x.rateLimits++;
  }
  a.lastUsedAt=now();a.lastStatus=status;
  const r=state.routes[poolId] ||= {requests:0,errors:0};
  r.requests++;if(status>=400)r.errors++;r.lastUsedAt=now();
  saveSoon();
}

export function usageSnapshot(){ return state; }

export function flushUsage(){
  if(timer)clearTimeout(timer);
  fs.mkdirSync(STATE_DIR,{recursive:true,mode:0o700});
  state.updatedAt=now();
  fs.writeFileSync(FILE,JSON.stringify(state,null,2)+"\n",{mode:0o600});
}
