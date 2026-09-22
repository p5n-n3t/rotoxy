import http from "node:http";
import https from "node:https";
import type { ProviderConfig, RotoxyConfig } from "./types.js";
import { getSecret } from "./config.js";

function joinUrl(base:string,requestPath:string){
  const b=new URL(base.endsWith("/")?base:base+"/");
  const basePath=b.pathname.replace(/\/$/,"");
  const req=requestPath.startsWith("/")?requestPath:"/"+requestPath;
  b.pathname=(basePath+req).replace(/\/+/g,"/");
  b.search="";
  return b;
}

function authHeaders(provider:ProviderConfig,secret:string){
  const header=provider.auth.header || (provider.auth.kind==="bearer"?"Authorization":"x-api-key");
  const prefix=provider.auth.prefix ?? (provider.auth.kind==="bearer"?"Bearer ":"");
  return {[header]:prefix+secret,...(provider.staticHeaders||{})};
}

function modelNames(provider:ProviderConfig,data:any):string[]{
  let items:any[]=[];
  if(Array.isArray(data?.models))items=data.models;
  else if(Array.isArray(data?.data))items=data.data;
  const out:string[]=[];
  for(const item of items){
    let name=typeof item==="string"?item:(item?.name||item?.model||item?.id);
    if(!name)continue;
    name=String(name);
    if(provider.adapter==="openrouter"&&provider.policy?.freeOnly){
      const prompt=Number(item?.pricing?.prompt);
      const completion=Number(item?.pricing?.completion);
      const zero=Number.isFinite(prompt)&&Number.isFinite(completion)&&prompt===0&&completion===0;
      if(name!=="openrouter/free"&&!name.endsWith(":free")&&!zero)continue;
    }
    out.push(name);
  }
  if(provider.adapter==="openrouter"&&provider.policy?.freeOnly&&!out.includes("openrouter/free"))out.unshift("openrouter/free");
  return [...new Set(out)].sort((a,b)=>a.localeCompare(b));
}

async function fetchJson(url:URL,headers:Record<string,string>){
  const transport=url.protocol==="http:"?http:https;
  return await new Promise<{status:number,data:any}>((resolve,reject)=>{
    const req=transport.request({protocol:url.protocol,hostname:url.hostname,port:url.port||undefined,path:url.pathname+url.search,method:"GET",headers},res=>{
      const chunks:Buffer[]=[];let bytes=0;
      res.on("data",(d:Buffer)=>{const b=Buffer.from(d);if(bytes<4_000_000){chunks.push(b.subarray(0,Math.max(0,4_000_000-bytes)));bytes+=b.length;}});
      res.on("end",()=>{
        const raw=Buffer.concat(chunks).toString("utf8");
        let data:any=raw;try{data=JSON.parse(raw);}catch{}
        resolve({status:res.statusCode||0,data});
      });
    });
    req.on("error",reject);req.end();
  });
}

export async function catalog(config:RotoxyConfig,providerFilter?:string){
  const providers:any[]=[];
  for(const [id,provider] of Object.entries(config.providers)){
    if(providerFilter&&id!==providerFilter)continue;
    if(provider.enabled===false)continue;
    const accounts:any[]=[];
    for(const account of provider.accounts.filter(a=>a.enabled!==false)){
      try{
        const path=provider.modelListPath||"/v1/models";
        const url=joinUrl(provider.baseUrl,path);
        const {status,data}=await fetchJson(url,authHeaders(provider,getSecret(account.secret)));
        accounts.push({id:account.id,name:account.name,status,models:status<400?modelNames(provider,data):[]});
      }catch(e:any){accounts.push({id:account.id,name:account.name,status:0,error:e.message,models:[]});}
    }
    const coverage=new Map<string,string[]>();
    for(const a of accounts)for(const m of a.models)coverage.set(m,[...(coverage.get(m)||[]),a.name]);
    providers.push({
      id,label:provider.label,adapter:provider.adapter,freeOnly:!!provider.policy?.freeOnly,
      accounts:accounts.map(a=>({id:a.id,name:a.name,status:a.status,error:a.error||null,modelCount:a.models.length})),
      models:[...coverage.entries()].map(([name,owners])=>({name,accountCoverage:owners.length,totalAccounts:accounts.length}))
    });
  }
  const global=new Map<string,string[]>();
  for(const p of providers)for(const m of p.models)global.set(m.name,[...(global.get(m.name)||[]),p.id]);
  return {
    providers,
    uniqueModels:[...global.entries()].map(([name,providers])=>({name,providers:[...new Set(providers)]})).sort((a,b)=>a.name.localeCompare(b.name))
  };
}
