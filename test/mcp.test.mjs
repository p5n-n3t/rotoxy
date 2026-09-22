import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inspectMcpServer, MCP_PRESETS, standardMcpJson } from "../dist/mcp.js";

const here=path.dirname(fileURLToPath(import.meta.url));

test("stdio MCP inspector discovers tools",async()=>{
  const result=await inspectMcpServer({
    id:"mock",label:"Mock",transport:"stdio",command:process.execPath,
    args:[path.join(here,"fixtures","mcp-stdio.mjs")],enabled:true,timeoutSeconds:5
  });
  assert.equal(result.ok,true);
  assert.ok(result.tools.some(t=>t.name==="ping"));
});

test("Exa preset is a public Streamable HTTP MCP endpoint",()=>{
  assert.equal(MCP_PRESETS.exa.transport,"streamable-http");
  assert.equal(MCP_PRESETS.exa.url,"https://mcp.exa.ai/mcp");
  assert.equal(MCP_PRESETS.exa.bearerTokenSecret,undefined);
});

test("standard MCP export points HTTP clients through the ROTOXY relay",()=>{
  const config={
    listen:{port:2025},mcp:{servers:{exa:{id:"exa",...structuredClone(MCP_PRESETS.exa)}},assignments:{}}
  };
  const out=standardMcpJson(config,["exa"]);
  assert.equal(out.mcpServers.exa.url,"http://127.0.0.1:2025/mcp/exa");
  assert.match(out.mcpServers.exa.headers.Authorization,/ROTOXY_CLIENT_TOKEN/);
});
