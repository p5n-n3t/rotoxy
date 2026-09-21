import http from "node:http";
import https from "node:https";
import * as dotenv from "dotenv";
dotenv.config();
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { IncomingMessage, RequestOptions, ServerResponse } from "node:http";

const ROOT = process.env.ROTOXY_DIR || process.cwd();
dotenv.config({ path: process.env.ROTOXY_ENV_FILE || path.join(ROOT, ".env") });

const expandHome = (p: string) => p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p;
const csv = (s = "") => s.split(",").map(v => v.trim()).filter(Boolean);
const intEnv = (name: string, fallback: number) => {
  const n = Number.parseInt(process.env[name] || "", 10);
  return Number.isFinite(n) ? n : fallback;
};

const PROVIDER = (process.env.ROTOXY_PROVIDER || "ollama").toLowerCase();
const legacyHost = process.env.DST_HOST ? `https://${process.env.DST_HOST}` : "";
const DST_BASE_URL = process.env.DST_BASE_URL || legacyHost || "https://ollama.com";
const SERVICE_HOST = process.env.SERVICE_HOST || "127.0.0.1";
const SERVICE_PORT = intEnv("SERVICE_PORT", 2025);
const API_KEYS = csv(process.env.API_KEYS);
const suppliedNames = csv(process.env.ACCOUNT_NAMES);
const ACCOUNT_NAMES = API_KEYS.map((_, i) => suppliedNames[i] || `Account ${i + 1}`);
const AUTH_HEADER = process.env.ROTOXY_AUTH_HEADER || (PROVIDER === "anthropic" ? "x-api-key" : PROVIDER === "google" ? "x-goog-api-key" : "Authorization");
const AUTH_PREFIX = process.env.ROTOXY_AUTH_PREFIX ?? (AUTH_HEADER.toLowerCase() === "authorization" ? "Bearer " : "");
const ROTATION = (process.env.ROTOXY_ROTATION || "round-robin").toLowerCase();
const COOLDOWN_SECONDS = intEnv("ROTOXY_COOLDOWN_SECONDS", 60);
const METER_BUDGET_TOKENS = Math.max(1, intEnv("ROTOXY_METER_BUDGET_TOKENS", 1_000_000));
const TOKEN_FILE = expandHome(process.env.ROTOXY_CLIENT_TOKEN_FILE || "~/.config/rotoxy/token");
const DATA_DIR = path.join(ROOT, "data");
const USAGE_FILE = path.join(DATA_DIR, "usage.json");

let STATIC_HEADERS: Record<string, string> = {};
try { STATIC_HEADERS = JSON.parse(process.env.ROTOXY_STATIC_HEADERS_JSON || "{}"); }
catch { console.error("Invalid ROTOXY_STATIC_HEADERS_JSON; ignoring it."); }

if (!API_KEYS.length) {
  console.error("ROTOXY: API_KEYS is empty. Run: rotoxy configure");
  process.exit(2);
}
if (!fs.existsSync(TOKEN_FILE)) {
  console.error(`ROTOXY: missing client token file: ${TOKEN_FILE}`);
  process.exit(2);
}
const CLIENT_TOKEN = fs.readFileSync(TOKEN_FILE, "utf8").trim();
if (!CLIENT_TOKEN) {
  console.error("ROTOXY: client token is empty.");
  process.exit(2);
}

type ModelStats = { requests:number; inputTokens:number; outputTokens:number; totalTokens:number };
type AccountStats = {
  name:string; requests:number; inputTokens:number; outputTokens:number; totalTokens:number;
  errors:number; rateLimits:number; lastUsedAt?:string; lastStatus?:number;
  byModel:Record<string, ModelStats>;
};
type UsageState = { version:number; createdAt:string; updatedAt:string; accounts:Record<string, AccountStats> };

fs.mkdirSync(DATA_DIR, { recursive: true });
const blankAccount = (name:string): AccountStats => ({
  name, requests:0, inputTokens:0, outputTokens:0, totalTokens:0, errors:0, rateLimits:0, byModel:{}

});
function loadUsage(): UsageState {
  try {
    const parsed = JSON.parse(fs.readFileSync(USAGE_FILE, "utf8")) as UsageState;
    API_KEYS.forEach((_,i) => {
      if (!parsed.accounts[String(i)]) parsed.accounts[String(i)] = blankAccount(ACCOUNT_NAMES[i]);
      parsed.accounts[String(i)].name = ACCOUNT_NAMES[i];
    });
    return parsed;
  } catch {
    const now = new Date().toISOString();
    return { version:1, createdAt:now, updatedAt:now,
      accounts:Object.fromEntries(API_KEYS.map((_,i) => [String(i), blankAccount(ACCOUNT_NAMES[i])])) };
  }
}
let usage = loadUsage();
let saveTimer: NodeJS.Timeout | undefined;
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    usage.updatedAt = new Date().toISOString();
    const tmp = `${USAGE_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(usage,null,2)+"\n", {mode:0o600});
    fs.renameSync(tmp, USAGE_FILE);
    saveTimer = undefined;
  }, 250);
}

const cooldownUntil = new Map<number,number>();
let nextIndex = 0;
function selectAccount(): number {
  const now = Date.now();
  const available = API_KEYS.map((_,i)=>i).filter(i => (cooldownUntil.get(i) || 0) <= now);
  const pool = available.length ? available : API_KEYS.map((_,i)=>i);
  if (ROTATION === "random") return pool[Math.floor(Math.random()*pool.length)];
  const selected = pool.find(i => i >= nextIndex) ?? pool[0];
  nextIndex = (selected+1) % API_KEYS.length;
  return selected;
}

const fingerprint = (key:string) => crypto.createHash("sha256").update(key).digest("hex").slice(0,10);
function timingSafeEqualText(a:string,b:string) {
  const aa=Buffer.from(a), bb=Buffer.from(b);
  return aa.length===bb.length && crypto.timingSafeEqual(aa,bb);
}
function clientCredential(req:IncomingMessage): string {
  const auth=String(req.headers.authorization || "");
  if (/^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i,"").trim();
  const x=req.headers["x-api-key"] || req.headers["api-key"];
  return Array.isArray(x) ? String(x[0] || "") : String(x || "");
}
const authorized = (req:IncomingMessage) => {
  const supplied=clientCredential(req);
  return supplied.length>0 && timingSafeEqualText(supplied,CLIENT_TOKEN);
};

const hopByHop = new Set(["connection","keep-alive","proxy-authenticate","proxy-authorization","te","trailer","transfer-encoding","upgrade","host","authorization","x-api-key","api-key","x-goog-api-key"]);
function upstreamHeaders(req:IncomingMessage, accountIndex:number): Record<string,string|string[]> {
  const headers:Record<string,string|string[]> = {};
  for (const [k,v] of Object.entries(req.headers)) {
    if (v!==undefined && !hopByHop.has(k.toLowerCase())) headers[k]=v;
  }
  for (const [k,v] of Object.entries(STATIC_HEADERS)) headers[k]=v;
  headers[AUTH_HEADER] = `${AUTH_PREFIX}${API_KEYS[accountIndex]}`;
  return headers;
}

function extractModel(body:string): string {
  if (!body) return "unknown";
  try {
    const obj=JSON.parse(body);
    return String(obj.model || obj.model_name || "unknown");
  } catch { return "unknown"; }
}

type TokenUsage = {input:number; output:number; total:number};
function tokenUsageFromObject(o:any): TokenUsage|null {
  if (!o || typeof o !== "object") return null;
  if (Number.isFinite(o.prompt_eval_count) || Number.isFinite(o.eval_count)) {
    const input=Number(o.prompt_eval_count||0), output=Number(o.eval_count||0);
    return {input,output,total:input+output};
  }
  if (o.usage && typeof o.usage === "object") {
    const input=Number(o.usage.prompt_tokens ?? o.usage.input_tokens ?? 0);
    const output=Number(o.usage.completion_tokens ?? o.usage.output_tokens ?? 0);
    const total=Number(o.usage.total_tokens ?? input+output);
    if (input || output || total) return {input,output,total};
  }
  if (o.usageMetadata && typeof o.usageMetadata === "object") {
    const input=Number(o.usageMetadata.promptTokenCount||0);
    const output=Number(o.usageMetadata.candidatesTokenCount||0);
    const total=Number(o.usageMetadata.totalTokenCount||input+output);
    if (input || output || total) return {input,output,total};
  }
  return null;
}

function extractUsage(body:string): TokenUsage {
  let best:TokenUsage={input:0,output:0,total:0};
  const consider=(obj:any) => {
    const u=tokenUsageFromObject(obj);
    if (u && u.total>=best.total) best=u;
  };
  try {
    consider(JSON.parse(body));
    if (best.total) return best;
  } catch {}
  for (const raw of body.split(/\r?\n/)) {
    let line=raw.trim();
    if (!line) continue;
    if (line.startsWith("data:")) line=line.slice(5).trim();
    if (!line || line==="[DONE]") continue;
    try { consider(JSON.parse(line)); } catch {}
  }
  return best;
}

function recordUsage(accountIndex:number, model:string, status:number, tokens:TokenUsage) {
  const a=usage.accounts[String(accountIndex)] ||= blankAccount(ACCOUNT_NAMES[accountIndex]);
  a.name=ACCOUNT_NAMES[accountIndex];
  a.requests++; a.inputTokens+=tokens.input; a.outputTokens+=tokens.output; a.totalTokens+=tokens.total;
  a.lastUsedAt=new Date().toISOString(); a.lastStatus=status;
  if (status>=400) a.errors++;
  if (status===429) a.rateLimits++;
  const m=a.byModel[model] ||= {requests:0,inputTokens:0,outputTokens:0,totalTokens:0};
  m.requests++; m.inputTokens+=tokens.input; m.outputTokens+=tokens.output; m.totalTokens+=tokens.total;
  scheduleSave();
}

function accountView(i:number) {
  const a=usage.accounts[String(i)] || blankAccount(ACCOUNT_NAMES[i]);
  const remaining=Math.max(0,100-(a.totalTokens/METER_BUDGET_TOKENS)*100);
  return {
    index:i+1,name:ACCOUNT_NAMES[i],keyFingerprint:fingerprint(API_KEYS[i]),
    requests:a.requests,inputTokens:a.inputTokens,outputTokens:a.outputTokens,totalTokens:a.totalTokens,
    meterRemainingPercent:Number(remaining.toFixed(2)),meterBudgetTokens:METER_BUDGET_TOKENS,
    meterIsProviderQuota:false,rateLimits:a.rateLimits,errors:a.errors,lastUsedAt:a.lastUsedAt||null,
    byModel:a.byModel
  };
}

function sendJson(res:ServerResponse,status:number,value:unknown) {
  const body=JSON.stringify(value,null,2)+"\n";
  res.writeHead(status,{"content-type":"application/json; charset=utf-8","content-length":Buffer.byteLength(body),"cache-control":"no-store"});
  res.end(body);
}

async function fetchModelsForAccount(i:number) {
  if (PROVIDER==="anthropic") {
    return {account:ACCOUNT_NAMES[i],supported:false,reason:"No generic model-list route configured for Anthropic."};
  }
  const route=PROVIDER==="ollama" ? "/api/tags" : "/v1/models";
  const u=new URL(route,DST_BASE_URL);
  return await new Promise<any>((resolve) => {
    const headers:Record<string,string>={[AUTH_HEADER]:`${AUTH_PREFIX}${API_KEYS[i]}`,...STATIC_HEADERS};
    const req=https.request({
      protocol:u.protocol,hostname:u.hostname,port:u.port||443,path:u.pathname+u.search,method:"GET",headers
    }, r => {
      const chunks:Buffer[]=[]; let bytes=0;
      r.on("data",(d:Buffer) => {
        const b=Buffer.from(d);
        if (bytes<2_000_000) {
          chunks.push(b.subarray(0,Math.max(0,2_000_000-bytes)));
          bytes+=b.length;
        }
      });
      r.on("end",() => {
        const raw=Buffer.concat(chunks).toString("utf8");
        let data:any=raw;
        try { data=JSON.parse(raw); } catch {}
        resolve({account:ACCOUNT_NAMES[i],status:r.statusCode||0,supported:true,data});
      });
    });
    req.on("error",e => resolve({account:ACCOUNT_NAMES[i],supported:true,error:e.message}));
    req.end();
  });
}
/* ROTOXY server wiring follows */
const server2 = http.createServer(async (clientReq:IncomingMessage, clientRes:ServerResponse) => {
  if (!authorized(clientReq)) {
    sendJson(clientRes, 401, {error: "Unauthorized"});
    return;
  }
  const route = clientReq.url || "/";
  if (route === "/__rotoxy/health") {
    sendJson(clientRes, 200, {ok:true,name:"rotoxy",provider:PROVIDER,accounts:API_KEYS.length,destination:DST_BASE_URL});
    return;
  }

  if (route === "/__rotoxy/usage" || route === "/__rotoxy/status") {
    sendJson(clientRes, 200, {
      provider: PROVIDER,
      destination: DST_BASE_URL,
      rotation: ROTATION,
      accounts: API_KEYS.map((_,i)=>accountView(i)),
      note: "The 100-to-0 meter is a local estimate, not provider-authoritative quota."
    });
    return;
  }
  if (route === "/__rotoxy/models") {
    const out:any[] = [];
    for (let i=0;i<API_KEYS.length;i++) out.push(await fetchModelsForAccount(i));
    sendJson(clientRes, 200, {provider:PROVIDER,accounts:out});
    return;
  }

  const accountIndex = selectAccount();
  const destination = new URL(route, DST_BASE_URL);
  const requestChunks:Buffer[] = [];
  let requestBytes = 0;
  let responseTail = Buffer.alloc(0);
  const cap = 1_000_000;
  const options:RequestOptions = {
    protocol: destination.protocol,
    hostname: destination.hostname,
    port: destination.port || (destination.protocol === "https:" ? 443 : 80),
    path: destination.pathname + destination.search,
    method: clientReq.method,
    headers: upstreamHeaders(clientReq, accountIndex)
  };
  const transport = destination.protocol === "https:" ? https : http;
  const proxyReq = transport.request(options, (proxyRes) => {
    const outHeaders = {...proxyRes.headers};
    delete outHeaders.connection;
    clientRes.writeHead(proxyRes.statusCode || 502, outHeaders);
    proxyRes.on("data",(chunk:Buffer)=>{
      const b=Buffer.from(chunk);
      responseTail=Buffer.concat([responseTail,b]);
      if (responseTail.length>cap) responseTail=responseTail.subarray(responseTail.length-cap);
      clientRes.write(b);
    });
    proxyRes.on("end",()=>{
      clientRes.end();
      const model=extractModel(Buffer.concat(requestChunks).toString("utf8"));
      const tokens=extractUsage(responseTail.toString("utf8"));
      const status=proxyRes.statusCode || 0;
      recordUsage(accountIndex,model,status,tokens);
      if (status===429) cooldownUntil.set(accountIndex,Date.now()+COOLDOWN_SECONDS*1000);
      if (status===401 || status===403) cooldownUntil.set(accountIndex,Date.now()+Math.max(300,COOLDOWN_SECONDS)*1000);
    });
  });
  proxyReq.on("error",(err:Error)=>{
    if (!clientRes.headersSent) sendJson(clientRes,502,{error:"Bad Gateway",detail:err.message});
    else clientRes.end();
    recordUsage(accountIndex,"unknown",502,{input:0,output:0,total:0});
  });
  clientReq.on("data",(chunk:Buffer)=>{
    const b=Buffer.from(chunk);
    if (requestBytes<cap) {
      requestChunks.push(b.subarray(0,Math.max(0,cap-requestBytes)));
      requestBytes += b.length;
    }
    proxyReq.write(b);
  });
  clientReq.on("end",()=>proxyReq.end());
  clientReq.on("error",()=>proxyReq.destroy());
});

server2.listen(SERVICE_PORT,SERVICE_HOST,()=>{
  console.log(`ROTOXY listening on http://${SERVICE_HOST}:${SERVICE_PORT}`);
  console.log(`provider=${PROVIDER} destination=${DST_BASE_URL} accounts=${API_KEYS.length} rotation=${ROTATION}`);
});
for (const sig of ["SIGTERM","SIGINT"] as const) {
  process.on(sig,()=>{
    if (saveTimer) clearTimeout(saveTimer);
    usage.updatedAt=new Date().toISOString();
    fs.writeFileSync(USAGE_FILE,JSON.stringify(usage,null,2)+"\n",{mode:0o600});
    server2.close(()=>process.exit(0));
    setTimeout(()=>process.exit(0),2000).unref();
  });
}
