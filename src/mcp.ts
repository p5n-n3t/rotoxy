import fs from "node:fs";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/client/stdio";
import type { McpServerConfig, RotoxyConfig } from "./types.js";
import { getSecret } from "./config.js";

export const MCP_PRESETS: Record<string, Omit<McpServerConfig,"id">> = {
  mem0: {
    label:"Mem0 Cloud",
    transport:"streamable-http",
    url:"https://mcp.mem0.ai/mcp",
    bearerTokenSecret:"ROTOXY_MCP_MEM0_API_KEY",
    enabled:true,
    timeoutSeconds:20,
    preset:"mem0"
  },
  exa: {
    label:"Exa Search",
    transport:"streamable-http",
    url:"https://mcp.exa.ai/mcp",
    enabled:true,
    timeoutSeconds:20,
    preset:"exa"
  },
  firecrawl: {
    label:"Firecrawl",
    transport:"stdio",
    command:"npx",
    args:["-y","firecrawl-mcp"],
    secretEnv:{FIRECRAWL_API_KEY:"ROTOXY_MCP_FIRECRAWL_API_KEY"},
    enabled:true,
    timeoutSeconds:30,
    preset:"firecrawl"
  }
};

export function ensureMcp(config:RotoxyConfig){
  config.mcp ||= {servers:{},assignments:{}};
  config.mcp.servers ||= {};
  config.mcp.assignments ||= {};
  return config.mcp;
}

export function getMcpServer(config:RotoxyConfig,id:string){
  const server=ensureMcp(config).servers[id];
  if(!server)throw new Error(`Unknown MCP server "${id}"`);
  return server;
}

export function resolvedMcpEnv(server:McpServerConfig){
  const env:Record<string,string>={...getDefaultEnvironment(),...(server.env||{})};
  for(const [name,secretRef] of Object.entries(server.secretEnv||{}))env[name]=getSecret(secretRef);
  return env;
}

export function resolvedMcpHeaders(server:McpServerConfig){
  const headers:Record<string,string>={...(server.headers||{})};
  for(const [name,secretRef] of Object.entries(server.secretHeaders||{}))headers[name]=getSecret(secretRef);
  if(server.bearerTokenSecret)headers.Authorization=`Bearer ${getSecret(server.bearerTokenSecret)}`;
  return headers;
}

export function mcpRelayPath(id:string){return `/mcp/${encodeURIComponent(id)}`;}

export function mcpRelayUrl(config:RotoxyConfig,id:string){
  return `http://127.0.0.1:${config.listen.port}${mcpRelayPath(id)}`;
}

export async function inspectMcpServer(server:McpServerConfig){
  const client=new Client({name:"rotoxy-mcp-inspector",version:"2.1.0"},{versionNegotiation:{mode:"auto"}});
  let transport:StreamableHTTPClientTransport|StdioClientTransport;
  if(server.transport==="streamable-http"){
    if(!server.url)throw new Error("MCP URL is missing");
    const headers=resolvedMcpHeaders(server);
    transport=new StreamableHTTPClientTransport(new URL(server.url),{
      requestInit:Object.keys(headers).length?{headers}:undefined
    });
  }else{
    if(!server.command)throw new Error("MCP command is missing");
    transport=new StdioClientTransport({
      command:server.command,
      args:server.args||[],
      env:resolvedMcpEnv(server),
      cwd:server.cwd,
      stderr:"pipe"
    });
  }

  const timeoutMs=Math.max(1,server.timeoutSeconds||20)*1000;
  let timer:NodeJS.Timeout|undefined;
  try{
    await Promise.race([
      client.connect(transport),
      new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(`MCP connection timed out after ${timeoutMs/1000}s`)),timeoutMs);})
    ]);
    if(timer)clearTimeout(timer);
    const listed:any=await Promise.race([
      client.listTools(),
      new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(`MCP tools/list timed out after ${timeoutMs/1000}s`)),timeoutMs);})
    ]);
    if(timer)clearTimeout(timer);
    return {
      ok:true,
      server:client.getServerVersion?.()||null,
      tools:(listed?.tools||[]).map((t:any)=>({
        name:t.name,
        description:t.description||"",
        hasInputSchema:!!t.inputSchema,
        hasOutputSchema:!!t.outputSchema
      }))
    };
  }finally{
    if(timer)clearTimeout(timer);
    await client.close().catch(()=>{});
    await transport.close().catch(()=>{});
  }
}

export function secretRefsForServer(server:McpServerConfig){
  return [
    ...(server.bearerTokenSecret?[server.bearerTokenSecret]:[]),
    ...Object.values(server.secretEnv||{}),
    ...Object.values(server.secretHeaders||{})
  ];
}

export function assignedServers(config:RotoxyConfig,target:string){
  const ids=new Set<string>([
    ...(config.mcp?.assignments?.["*"]||[]),
    ...(config.mcp?.assignments?.[target]||[])
  ]);
  return [...ids].filter(id=>config.mcp?.servers?.[id]?.enabled!==false);
}

export function standardMcpJson(config:RotoxyConfig,ids?:string[]){
  const wanted=ids?.length?ids:Object.keys(ensureMcp(config).servers);
  const out:Record<string,any>={};
  for(const id of wanted){
    const s=getMcpServer(config,id);
    if(s.transport==="streamable-http"){
      const entry:any={type:"http",url:mcpRelayUrl(config,id),headers:{Authorization:"Bearer ${ROTOXY_CLIENT_TOKEN}"}};
      out[id]=entry;
    }else{
      out[id]={command:"rotoxy",args:["mcp","stdio",id]};
    }
  }
  return {mcpServers:out};
}
