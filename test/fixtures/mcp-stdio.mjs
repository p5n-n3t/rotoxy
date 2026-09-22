import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";

serveStdio(() => {
  const server=new McpServer({name:"rotoxy-test-mcp",version:"2.0.0"});
  server.registerTool("ping",{
    description:"Return pong",
    inputSchema:{}
  },async()=>({content:[{type:"text",text:"pong"}]}));
  return server;
});
