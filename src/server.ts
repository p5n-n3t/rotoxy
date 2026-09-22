import http, { IncomingMessage, ServerResponse } from "node:http";
import https from "node:https";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ProviderConfig, RotoxyConfig } from "./types.js";
import { catalog } from "./catalog.js";
import { classifyRequest, markCooldown, resolveRoute, TASK_CATEGORIES } from "./router.js";
import { extractUsage, flushUsage, recordUsage, usageSnapshot } from "./usage.js";

const MAX_REQUEST_BYTES = Number(process.env.ROTOXY_MAX_REQUEST_BYTES || 50 * 1024 * 1024);
const MAX_RESPONSE_CAPTURE = Number(process.env.ROTOXY_MAX_RESPONSE_CAPTURE || 2 * 1024 * 1024);

function expandHome(p:string){ return p.startsWith("~/") ? path.join(os.homedir(),p.slice(2)) : p; }
function safeEqual(a:string,b:string){
  const x=Buffer.from(a),y=Buffer.from(b);
  return x.length===y.length && cryptoSafe(x,y);
}
function cryptoSafe(a:Buffer,b:Buffer){
  let diff=0;for(let i=0;i<a.length;i++)diff|=a[i]^b[i];return diff===0;
}
function credential(req:IncomingMessage){
  const auth=String(req.headers.authorization||"");
  if(/^Bearer\s+/i.test(auth))return auth.replace(/^Bearer\s+/i,"").trim();
  const value=req.headers["x-rotoxy-token"]||req.headers["x-api-key"]||req.headers["api-key"];
  return Array.isArray(value)?String(value[0]||""):String(value||"");
}
function clientToken(config:RotoxyConfig){
  const file=expandHome(config.security.tokenFile);
  if(!fs.existsSync(file))throw new Error(`Missing ROTOXY token: ${file}`);
  return fs.readFileSync(file,"utf8").trim();
}
function sendJson(res:ServerResponse,status:number,value:any){
  const body=JSON.stringify(value,null,2)+"\n";
  res.writeHead(status,{"content-type":"application/json; charset=utf-8","content-length":Buffer.byteLength(body),"cache-control":"no-store"});
  res.end(body);
}
function joinUrl(base:string,requestPath:string){
  const b=new URL(base.endsWith("/")?base:base+"/");
  const basePath=b.pathname.replace(/\/$/,"");
  const u=new URL(requestPath,"http://rotoxy.local");
  b.pathname=(basePath+u.pathname).replace(/\/+/g,"/");
  b.search=u.search;
  return b;
}
const blockedHeaders=new Set([
  "connection","keep-alive","proxy-authenticate","proxy-authorization","te","trailer","transfer-encoding","upgrade","host",
  "authorization","x-api-key","api-key","x-goog-api-key","x-rotoxy-token","x-rotoxy-provider","x-rotoxy-pool",
  "x-rotoxy-task","x-rotoxy-difficulty","content-length"
]);
function upstreamHeaders(req:IncomingMessage,provider:ProviderConfig,secret:string,bodyLength:number){
  const h:Record<string,string|string[]>={};
  for(const [k,v] of Object.entries(req.headers))if(v!==undefined&&!blockedHeaders.has(k.toLowerCase()))h[k]=v;
  for(const [k,v] of Object.entries(provider.staticHeaders||{}))h[k]=v;
  const authHeader=provider.auth.header||(provider.auth.kind==="bearer"?"Authorization":"x-api-key");
  const prefix=provider.auth.prefix??(provider.auth.kind==="bearer"?"Bearer ":"");
  h[authHeader]=prefix+secret;
  h["content-length"]=String(bodyLength);
  return h;
}
async function readBody(req:IncomingMessage){
  const chunks:Buffer[]=[];let total=0;
  for await(const chunk of req){
    const b=Buffer.from(chunk);total+=b.length;
    if(total>MAX_REQUEST_BYTES)throw new Error(`Request body exceeds ${MAX_REQUEST_BYTES} bytes`);
    chunks.push(b);
  }
  return Buffer.concat(chunks);
}
function parseJsonBody(req:IncomingMessage,body:Buffer){
  const ct=String(req.headers["content-type"]||"");
  if(!body.length||(!ct.includes("json")&&!body.toString("utf8",0,Math.min(1,body.length)).match(/[\[{]/)))return null;
  try{return JSON.parse(body.toString("utf8"));}catch{return null;}
}
function rewriteModel(original:Buffer,parsed:any,model?:string){
  if(!parsed||!model)return original;
  if(parsed.model===model)return original;
  const copy={...parsed,model};
  return Buffer.from(JSON.stringify(copy));
}

export function createRotoxyServer(config:RotoxyConfig){
  return http.createServer(async(req,res)=>{
    try{
      if(!safeEqual(credential(req),clientToken(config))){sendJson(res,401,{error:"Unauthorized",message:"Supply the ROTOXY client token."});return;}
      const rawPath=req.url||"/";

      if(rawPath==="/__rotoxy/health"){
        sendJson(res,200,{ok:true,name:"rotoxy",version:2,providers:Object.keys(config.providers).length,pools:Object.keys(config.pools).length,defaultPool:config.defaultPool});
        return;
      }
      if(rawPath==="/__rotoxy/config"){
        sendJson(res,200,{
          version:config.version,listen:config.listen,exposure:config.exposure,defaultPool:config.defaultPool,
          providers:Object.values(config.providers).map(p=>({id:p.id,label:p.label,adapter:p.adapter,wire:p.wire,accounts:p.accounts.length,freeOnly:!!p.policy?.freeOnly,defaultModel:p.defaultModel||null})),
          pools:Object.values(config.pools).map(p=>({id:p.id,label:p.label,type:p.type,strategy:p.strategy,provider:p.provider||null,targets:p.targets||[]})),
          routers:config.routers
        });
        return;
      }
      if(rawPath==="/__rotoxy/usage"){sendJson(res,200,usageSnapshot());return;}
      if(rawPath.startsWith("/__rotoxy/catalog")){
        const u=new URL(rawPath,"http://rotoxy.local");
        sendJson(res,200,await catalog(config,u.searchParams.get("provider")||undefined));return;
      }
      if(rawPath==="/__rotoxy/tasks"){
        sendJson(res,200,{categories:TASK_CATEGORIES,routers:config.routers});return;
      }

      const incoming=await readBody(req);
      const parsed=parseJsonBody(req,incoming);
      if(rawPath==="/__rotoxy/classify"){
        sendJson(res,200,classifyRequest(parsed||{}));return;
      }

      const {decision,classification}=resolveRoute(config,rawPath,req.headers,parsed||{});
      const provider=config.providers[decision.providerId];
      if(!provider)throw new Error(`Provider "${decision.providerId}" vanished from config`);
      const outgoing=rewriteModel(incoming,parsed,decision.upstreamModel);
      const dst=joinUrl(provider.baseUrl,decision.path);
      const transport=dst.protocol==="http:"?http:https;
      const headers=upstreamHeaders(req,provider,decision.accountSecret,outgoing.length);

      const proxyReq=transport.request({
        protocol:dst.protocol,hostname:dst.hostname,port:dst.port||undefined,path:dst.pathname+dst.search,method:req.method,headers
      },proxyRes=>{
        const outHeaders={...proxyRes.headers};
        delete outHeaders.connection;
        outHeaders["x-rotoxy-provider"]=decision.providerId;
        outHeaders["x-rotoxy-pool"]=decision.poolId;
        if(decision.upstreamModel)outHeaders["x-rotoxy-model"]=decision.upstreamModel;
        res.writeHead(proxyRes.statusCode||502,outHeaders);

        let capture=Buffer.alloc(0);
        proxyRes.on("data",(chunk:Buffer)=>{
          const b=Buffer.from(chunk);
          if(capture.length<MAX_RESPONSE_CAPTURE){
            const room=MAX_RESPONSE_CAPTURE-capture.length;
            capture=Buffer.concat([capture,b.subarray(0,room)]);
          }
          res.write(b);
        });
        proxyRes.on("end",()=>{
          res.end();
          const status=proxyRes.statusCode||0;
          const tokens=extractUsage(capture.toString("utf8"));
          recordUsage({
            providerId:decision.providerId,accountId:decision.accountId,
            model:decision.upstreamModel||decision.requestedModel||"unknown",
            poolId:decision.poolId,status,tokens
          });
          if(status===429)markCooldown(decision.providerId,decision.accountId,60);
          if(status===401||status===403)markCooldown(decision.providerId,decision.accountId,300);
        });
      });
      proxyReq.on("error",(err)=>{
        if(!res.headersSent)sendJson(res,502,{error:"Bad Gateway",message:err.message,provider:decision.providerId,pool:decision.poolId});
        else res.end();
        recordUsage({providerId:decision.providerId,accountId:decision.accountId,model:decision.upstreamModel||"unknown",poolId:decision.poolId,status:502,tokens:{input:0,output:0,total:0}});
      });
      proxyReq.end(outgoing);
    }catch(err:any){
      if(!res.headersSent)sendJson(res,400,{error:"ROTOXY request error",message:err?.message||String(err)});
      else res.end();
    }
  });
}

export function shutdownUsage(){flushUsage();}
