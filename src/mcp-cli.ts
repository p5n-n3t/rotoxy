import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import { spawn, spawnSync } from "node:child_process";
import { stdin as input, stdout as output } from "node:process";
import { CONFIG_DIR, SECRETS_FILE, loadConfig, saveConfig } from "./config.js";
import { MCP_PRESETS, assignedServers, ensureMcp, getMcpServer, inspectMcpServer, mcpRelayUrl, resolvedMcpEnv, standardMcpJson } from "./mcp.js";
import type { McpServerConfig, RotoxyConfig } from "./types.js";

const C={reset:"\x1b[0m",bold:"\x1b[1m",dim:"\x1b[2m",green:"\x1b[32m",yellow:"\x1b[33m",red:"\x1b[31m",cyan:"\x1b[36m",blue:"\x1b[34m"};
const color=(c:string,s:string)=>process.env.NO_COLOR?s:c+s+C.reset;
const ok=(s:string)=>console.log(color(C.green,"✓ ")+s);
const info=(s:string)=>console.log(color(C.cyan,"• ")+s);
const warn=(s:string)=>console.log(color(C.yellow,"! ")+s);
const slug=(s:string)=>s.toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"");
const has=(cmd:string)=>spawnSync(process.platform==="win32"?"where":"which",[cmd],{encoding:"utf8"}).status===0;

function readSecrets(){
  const out:Record<string,string>={};
  if(!fs.existsSync(SECRETS_FILE))return out;
  for(const line of fs.readFileSync(SECRETS_FILE,"utf8").split(/\r?\n/)){
    if(!line||line.trim().startsWith("#")||!line.includes("="))continue;
    const i=line.indexOf("=");out[line.slice(0,i).trim()]=line.slice(i+1);
  }
  return out;
}
function writeSecrets(values:Record<string,string>){
  fs.mkdirSync(path.dirname(SECRETS_FILE),{recursive:true,mode:0o700});
  const lines=["# ROTOXY secrets. Never commit this file."];
  for(const k of Object.keys(values).sort())lines.push(`${k}=${values[k]}`);
  fs.writeFileSync(SECRETS_FILE,lines.join("\n")+"\n",{mode:0o600});
  fs.chmodSync(SECRETS_FILE,0o600);
}
function setSecret(name:string,value:string){
  const values=readSecrets();values[name]=value;writeSecrets(values);process.env[name]=value;
}
function removeUnreferencedSecrets(config:RotoxyConfig,refs:string[]){
  const still=new Set<string>();
  for(const p of Object.values(config.providers))for(const a of p.accounts)still.add(a.secret);
  for(const s of Object.values(config.mcp.servers)){
    if(s.bearerTokenSecret)still.add(s.bearerTokenSecret);
    Object.values(s.secretEnv||{}).forEach(x=>still.add(x));
    Object.values(s.secretHeaders||{}).forEach(x=>still.add(x));
  }
  const values=readSecrets();
  let changed=false;
  for(const ref of refs)if(!still.has(ref)&&ref in values){delete values[ref];changed=true;}
  if(changed)writeSecrets(values);
}
function promptSecret(label:string){
  const script='stty -echo 2>/dev/null || true; printf "%s" "$1" >&2; IFS= read -r x; stty echo 2>/dev/null || true; printf "\\n" >&2; printf "%s" "$x"';
  const r=spawnSync("bash",["-c",script,"bash",label],{stdio:["inherit","pipe","inherit"],encoding:"utf8"});
  if(r.status!==0)throw new Error("Could not read secret.");
  return (r.stdout||"").trim();
}
async function choose(rl:readline.Interface,title:string,items:{id:string,label:string}[],allowBack=true){
  console.log("\n"+color(C.bold,title));
  items.forEach((x,i)=>console.log(`  ${i+1}) ${x.label} ${color(C.dim,"("+x.id+")")}`));
  if(allowBack)console.log("  0) Back");
  const ans=(await rl.question("> ")).trim();
  if(allowBack&&(ans==="0"||ans===""))return null;
  const n=Number(ans);
  if(Number.isInteger(n)&&n>=1&&n<=items.length)return items[n-1].id;
  return items.find(x=>x.id===ans)?.id||null;
}
function summary(config:RotoxyConfig,json=false){
  const servers=Object.values(ensureMcp(config).servers);
  if(json){console.log(JSON.stringify({servers,assignments:config.mcp.assignments},null,2));return;}
  console.log(color(C.bold,`ROTOXY MCP registry • ${servers.length} server${servers.length===1?"":"s"}`));
  if(!servers.length){console.log("  No MCP servers configured. Run: rotoxy mcp add");return;}
  for(const s of servers){
    const target=s.transport==="streamable-http"?(s.url||"missing URL"):`${s.command||"?"} ${(s.args||[]).join(" ")}`;
    console.log(`  ${s.enabled===false?color(C.dim,"○"):color(C.green,"●")} ${color(C.cyan,s.id.padEnd(14))} ${s.transport.padEnd(15)} ${target}`);
  }
  const assignments=Object.entries(config.mcp.assignments||{});
  if(assignments.length){
    console.log("\n"+color(C.bold,"Assignments"));
    for(const [target,ids] of assignments)console.log(`  ${target}: ${ids.join(", ")||"none"}`);
  }
}

async function addPreset(rl:readline.Interface,config:RotoxyConfig,presetId:string){
  const preset=MCP_PRESETS[presetId];
  if(!preset)throw new Error(`Unknown MCP preset "${presetId}"`);
  const entered=(await rl.question(`Server ID [${presetId}]: `)).trim();
  const id=slug(entered||presetId);
  if(!id)throw new Error("Server ID is required.");
  if(config.mcp.servers[id]){
    const yes=(await rl.question(`"${id}" already exists. Replace it? [y/N]: `)).trim().toLowerCase();
    if(yes!=="y")return;
  }
  const server:McpServerConfig={id,...structuredClone(preset)};
  if(presetId==="mem0"){
    const ref=`ROTOXY_MCP_${id.toUpperCase().replace(/[^A-Z0-9]/g,"_")}_API_KEY`;
    const key=promptSecret("Mem0 API key: ");
    if(!key)throw new Error("Mem0 API key is required.");
    setSecret(ref,key);server.bearerTokenSecret=ref;
  }else if(presetId==="firecrawl"){
    const ref=`ROTOXY_MCP_${id.toUpperCase().replace(/[^A-Z0-9]/g,"_")}_API_KEY`;
    const key=promptSecret("Firecrawl API key: ");
    if(!key)throw new Error("Firecrawl API key is required.");
    setSecret(ref,key);server.secretEnv={FIRECRAWL_API_KEY:ref};
  }
  config.mcp.servers[id]=server;
  saveConfig(config);
  ok(`Added MCP server ${id} (${server.label}).`);
  if(server.transport==="streamable-http")info(`ROTOXY relay: ${mcpRelayUrl(config,id)}`);
}

async function addCustom(rl:readline.Interface,config:RotoxyConfig){
  const id=slug((await rl.question("Server ID: ")).trim());
  if(!id)throw new Error("Server ID is required.");
  const label=(await rl.question(`Label [${id}]: `)).trim()||id;
  const transport=await choose(rl,"Transport",[
    {id:"streamable-http",label:"Streamable HTTP / remote MCP"},
    {id:"stdio",label:"stdio / local command"}
  ],false);
  if(!transport)return;
  let server:McpServerConfig={id,label,transport:transport as any,enabled:true,timeoutSeconds:20,preset:"custom"};
  if(transport==="streamable-http"){
    const url=(await rl.question("MCP URL: ")).trim();
    if(!url)throw new Error("URL is required.");
    new URL(url);
    server.url=url;
    const auth=await choose(rl,"Authentication",[
      {id:"none",label:"None"},
      {id:"bearer",label:"Bearer token / API key"},
      {id:"header",label:"Custom secret header"}
    ],false);
    if(auth==="bearer"){
      const ref=`ROTOXY_MCP_${id.toUpperCase().replace(/[^A-Z0-9]/g,"_")}_TOKEN`;
      const value=promptSecret("Bearer token/API key: ");
      if(!value)throw new Error("Token is required.");
      setSecret(ref,value);server.bearerTokenSecret=ref;
    }else if(auth==="header"){
      const header=(await rl.question("Header name [X-API-Key]: ")).trim()||"X-API-Key";
      const ref=`ROTOXY_MCP_${id.toUpperCase().replace(/[^A-Z0-9]/g,"_")}_HEADER`;
      const value=promptSecret(`${header}: `);
      if(!value)throw new Error("Header value is required.");
      setSecret(ref,value);server.secretHeaders={[header]:ref};
    }
  }else{
    const command=(await rl.question("Command: ")).trim();
    if(!command)throw new Error("Command is required.");
    const argsLine=(await rl.question("Arguments (space-separated, blank = none): ")).trim();
    server.command=command;server.args=argsLine?argsLine.split(/\s+/):[];
    const secretEnv:Record<string,string>={};
    while(true){
      const envName=(await rl.question("Secret env variable name (blank = finished): ")).trim();
      if(!envName)break;
      const ref=`ROTOXY_MCP_${id.toUpperCase().replace(/[^A-Z0-9]/g,"_")}_${envName.toUpperCase().replace(/[^A-Z0-9]/g,"_")}`;
      const value=promptSecret(`${envName}: `);
      if(!value)throw new Error(`${envName} value is required.`);
      setSecret(ref,value);secretEnv[envName]=ref;
    }
    if(Object.keys(secretEnv).length)server.secretEnv=secretEnv;
  }
  config.mcp.servers[id]=server;saveConfig(config);ok(`Added custom MCP server ${id}.`);
}

async function addInteractive(config:RotoxyConfig,presetArg?:string){
  const rl=readline.createInterface({input,output});
  try{
    let preset=presetArg;
    if(!preset){
      preset=await choose(rl,"Add MCP server",[
        {id:"mem0",label:"Mem0 Cloud memory"},
        {id:"exa",label:"Exa web/search"},
        {id:"firecrawl",label:"Firecrawl search/scrape/crawl"},
        {id:"custom",label:"Generic/custom MCP server"}
      ])||undefined;
    }
    if(!preset)return;
    if(preset==="custom")await addCustom(rl,config);
    else await addPreset(rl,config,preset);
  }finally{rl.close();}
}

async function testServer(config:RotoxyConfig,id:string,json=false){
  const server=getMcpServer(config,id);
  info(`Connecting to ${id}...`);
  const result=await inspectMcpServer(server);
  if(json){console.log(JSON.stringify(result,null,2));return;}
  ok(`${id} connected • ${result.tools.length} tool${result.tools.length===1?"":"s"}`);
  for(const t of result.tools)console.log(`  ${color(C.green,"•")} ${color(C.cyan,t.name)}${t.description?" — "+t.description.replace(/\s+/g," ").slice(0,160):""}`);
}

function assign(config:RotoxyConfig,id:string,target:string,remove=false){
  getMcpServer(config,id);
  const list=new Set(config.mcp.assignments[target]||[]);
  if(remove)list.delete(id);else list.add(id);
  config.mcp.assignments[target]=[...list];
  if(!config.mcp.assignments[target].length)delete config.mcp.assignments[target];
  saveConfig(config);
  ok(`${remove?"Unassigned":"Assigned"} ${id} ${remove?"from":"to"} ${target}.`);
}

function removeServer(config:RotoxyConfig,id:string){
  const server=getMcpServer(config,id);
  const refs=[
    ...(server.bearerTokenSecret?[server.bearerTokenSecret]:[]),
    ...Object.values(server.secretEnv||{}),
    ...Object.values(server.secretHeaders||{})
  ];
  delete config.mcp.servers[id];
  for(const [target,ids] of Object.entries(config.mcp.assignments)){
    config.mcp.assignments[target]=ids.filter(x=>x!==id);
    if(!config.mcp.assignments[target].length)delete config.mcp.assignments[target];
  }
  saveConfig(config);removeUnreferencedSecrets(config,refs);ok(`Removed MCP server ${id}.`);
}

function command(cmd:string,args:string[],opts:any={}){
  const r=spawnSync(cmd,args,{stdio:opts.capture?"pipe":"inherit",encoding:"utf8",env:{...process.env,...(opts.env||{})}});
  return r;
}
function rotoxyToken(config:RotoxyConfig){
  const p=config.security.tokenFile.startsWith("~/")?path.join(os.homedir(),config.security.tokenFile.slice(2)):config.security.tokenFile;
  return fs.readFileSync(p,"utf8").trim();
}

function syncOne(config:RotoxyConfig,clientName:string,id:string){
  const server=getMcpServer(config,id);
  const relay=server.transport==="streamable-http"?mcpRelayUrl(config,id):"";
  const token=rotoxyToken(config);
  if(clientName==="codex"){
    if(!has("codex"))return {ok:false,message:"Codex CLI not installed"};
    command("codex",["mcp","remove",id],{capture:true});
    if(server.transport==="streamable-http"){
      const r=command("codex",["mcp","add",id,"--url",relay,"--bearer-token-env-var","ROTOXY_CLIENT_TOKEN"],{capture:true,env:{ROTOXY_CLIENT_TOKEN:token}});
      if(r.status!==0)return {ok:false,message:(r.stderr||r.stdout||"codex mcp add failed").trim()};
      return {ok:true,message:"synced through local ROTOXY relay; ROTOXY-delegated Codex receives the token environment automatically"};
    }
    const r=command("codex",["mcp","add",id,"--","rotoxy","mcp","stdio",id],{capture:true});
    return {ok:r.status===0,message:r.status===0?"synced stdio wrapper":(r.stderr||"codex mcp add failed").trim()};
  }
  if(clientName==="claude"){
    if(!has("claude"))return {ok:false,message:"Claude Code not installed"};
    command("claude",["mcp","remove","-s","user",id],{capture:true});
    const args=server.transport==="streamable-http"
      ?["mcp","add","-s","user","--transport","http",id,relay,"--header",`Authorization: Bearer ${token}`]
      :["mcp","add","-s","user",id,"--","rotoxy","mcp","stdio",id];
    const r=command("claude",args,{capture:true});
    return {ok:r.status===0,message:r.status===0?"synced":(r.stderr||r.stdout||"claude mcp add failed").trim()};
  }
  if(clientName==="gemini"){
    if(!has("gemini"))return {ok:false,message:"Gemini CLI not installed"};
    command("gemini",["mcp","remove","-s","user",id],{capture:true});
    const args=server.transport==="streamable-http"
      ?["mcp","add","-s","user","--transport","http","--header",`Authorization: Bearer ${token}`,id,relay]
      :["mcp","add","-s","user","--transport","stdio",id,"rotoxy","mcp","stdio",id];
    const r=command("gemini",args,{capture:true});
    return {ok:r.status===0,message:r.status===0?"synced":(r.stderr||r.stdout||"gemini mcp add failed").trim()};
  }
  if(clientName==="copilot"){
    if(!has("copilot"))return {ok:false,message:"Copilot CLI not installed"};
    command("copilot",["mcp","remove",id],{capture:true});
    const args=server.transport==="streamable-http"
      ?["mcp","add","--transport","http","--header",`Authorization: Bearer ${token}`,id,relay]
      :["mcp","add",id,"--","rotoxy","mcp","stdio",id];
    const r=command("copilot",args,{capture:true});
    return {ok:r.status===0,message:r.status===0?"synced":(r.stderr||r.stdout||"copilot mcp add failed").trim()};
  }
  return {ok:false,message:`Native sync adapter for ${clientName} is not implemented; use "rotoxy mcp export".`};
}

function sync(config:RotoxyConfig,target:string,serverArg?:string){
  const clients=target==="all"?["codex","claude","gemini","copilot"]:[target];
  for(const client of clients){
    const direct=assignedServers(config,client);
    const profileIds=Object.values(config.workers.profiles).filter(p=>p.adapter===client).flatMap(p=>assignedServers(config,p.id));
    const assigned=[...new Set([...direct,...profileIds])];
    const ids=serverArg?[serverArg]:(assigned.length?assigned:Object.keys(config.mcp.servers));
    console.log("\n"+color(C.bold,`${client} MCP sync`));
    if(!ids.length){console.log("  Nothing to sync.");continue;}
    for(const id of ids){
      const result=syncOne(config,client,id);
      console.log(`  ${result.ok?color(C.green,"✓"):color(C.yellow,"!")} ${id}: ${result.message}`);
    }
  }
}

function exportConfig(config:RotoxyConfig,target?:string){
  const ids=target&&target!=="all"?assignedServers(config,target):undefined;
  console.log(JSON.stringify(standardMcpJson(config,ids),null,2));
}

function stdio(config:RotoxyConfig,id:string){
  const server=getMcpServer(config,id);
  if(server.transport!=="stdio")throw new Error(`${id} is not a stdio MCP server.`);
  if(!server.command)throw new Error(`${id} has no command.`);
  const child=spawn(server.command,server.args||[],{cwd:server.cwd,env:resolvedMcpEnv(server),stdio:"inherit"});
  child.on("error",e=>{console.error(e.message);process.exit(1);});
  child.on("exit",(code,signal)=>{if(signal)process.kill(process.pid,signal);else process.exit(code??1);});
}

async function menu(config:RotoxyConfig){
  const rl=readline.createInterface({input,output});
  try{
    while(true){
      console.log("");summary(loadConfig());
      const action=await choose(rl,"MCP management",[
        {id:"add",label:"Add MCP server"},
        {id:"test",label:"Test server and list tools"},
        {id:"assign",label:"Assign server to an agent/worker"},
        {id:"sync",label:"Sync registry into Codex / Claude / Copilot"},
        {id:"remove",label:"Remove MCP server"}
      ]);
      if(!action)break;
      const cfg=loadConfig();
      if(action==="add"){rl.close();await addInteractive(cfg);return menu(loadConfig());}
      const ids=Object.keys(cfg.mcp.servers);
      if(!ids.length){warn("No MCP servers configured.");continue;}
      const id=await choose(rl,"Choose MCP server",ids.map(id=>({id,label:cfg.mcp.servers[id].label})));
      if(!id)continue;
      if(action==="test")await testServer(cfg,id);
      if(action==="remove")removeServer(cfg,id);
      if(action==="assign"){
        const target=(await rl.question("Worker/client ID (codex, claude, copilot, gemini, *, etc.): ")).trim();
        if(target)assign(cfg,id,target);
      }
      if(action==="sync"){
        const target=await choose(rl,"Sync to client",[
          {id:"all",label:"All supported local MCP clients"},
          {id:"codex",label:"Codex CLI"},
          {id:"claude",label:"Claude Code"},
          {id:"gemini",label:"Gemini CLI"},
          {id:"copilot",label:"GitHub Copilot CLI"}
        ]);
        if(target)sync(cfg,target,id);
      }
    }
  }finally{rl.close();}
}

async function main(){
  const config=loadConfig();ensureMcp(config);
  const cmd=process.argv[2]||"list";
  if(cmd==="list"||cmd==="ls"){summary(config,process.argv.includes("--json"));return;}
  if(cmd==="add"){await addInteractive(config,process.argv[3]);return;}
  if(cmd==="menu"){await menu(config);return;}
  if(cmd==="test"||cmd==="tools"){const id=process.argv[3];if(!id)throw new Error(`Usage: rotoxy mcp ${cmd} SERVER`);await testServer(config,id,process.argv.includes("--json"));return;}
  if(cmd==="remove"||cmd==="rm"){const id=process.argv[3];if(!id)throw new Error("Usage: rotoxy mcp remove SERVER");removeServer(config,id);return;}
  if(cmd==="assign"){const id=process.argv[3],target=process.argv[4];if(!id||!target)throw new Error("Usage: rotoxy mcp assign SERVER WORKER|CLIENT|*");assign(config,id,target);return;}
  if(cmd==="unassign"){const id=process.argv[3],target=process.argv[4];if(!id||!target)throw new Error("Usage: rotoxy mcp unassign SERVER WORKER|CLIENT|*");assign(config,id,target,true);return;}
  if(cmd==="sync"){const target=process.argv[3]||"all";sync(config,target,process.argv[4]);return;}
  if(cmd==="export"){exportConfig(config,process.argv[3]);return;}
  if(cmd==="stdio"){const id=process.argv[3];if(!id)throw new Error("Usage: rotoxy mcp stdio SERVER");stdio(config,id);return;}
  if(cmd==="endpoint"){const id=process.argv[3];if(!id)throw new Error("Usage: rotoxy mcp endpoint SERVER");getMcpServer(config,id);console.log(mcpRelayUrl(config,id));return;}
  throw new Error(`Unknown MCP command "${cmd}". Try: rotoxy mcp list`);
}
main().catch(e=>{console.error(color(C.red,"ROTOXY: "+e.message));process.exit(1);});
