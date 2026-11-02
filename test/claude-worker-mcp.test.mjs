import test from 'node:test';import assert from 'node:assert/strict';import express from 'express';import {createServer} from 'node:http';import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {StateStore} from '../dist/store.js';import {CredentialPool} from '../dist/pool.js';import {McpProxy} from '../dist/proxy.js';
test('Claude worker MCP scopes and exact local names never fall through to another provider',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'claude-mcp-'));const old=process.env.ROTOXY_CONFIG_DIR;process.env.ROTOXY_CONFIG_DIR=dir;const store=new StateStore();if(old===undefined)delete process.env.ROTOXY_CONFIG_DIR;else process.env.ROTOXY_CONFIG_DIR=old;await store.init({adminPassword:'synthetic-claude-mcp-password'});
 let scope='mcp jobs:read',calls=[];
 const worker={async call(name,args,client){calls.push({name,args,client});return {accepted:true};}};
 const backend={authorizeWorkspace:async()=>{},listProjects:()=>['project-a']};
 const proxy=new McpProxy(store,new CredentialPool(store),undefined,undefined,undefined,undefined,{backend,service:{}},undefined,worker);
 const app=express();app.use(express.raw({type:'application/json'}));app.use((req,res,next)=>{res.locals.oauthClaims={client_id:'test-client',scope};next();});app.post('/mcp',proxy.handler);
 const server=createServer(app);await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});});
 const rpc=(method,params)=>fetch(`http://127.0.0.1:${server.address().port}/mcp`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});
 let response=await rpc('tools/list');let tools=(await response.json()).result.tools.map(t=>t.name);assert.ok(tools.includes('claude_workers'));assert.ok(tools.includes('claude_task_status'));assert.ok(!tools.includes('claude_task_submit'));
 response=await rpc('tools/call',{name:'claude_task_submit',arguments:{projectId:'project-a',taskId:'task-a',profileId:'profile-test-claude',model:'test'}});assert.equal(response.status,403);assert.equal(calls.length,0);
 scope='mcp jobs:read jobs:write';response=await rpc('tools/call',{name:'claude_task_submit',arguments:{projectId:'project-a',taskId:'task-a',profileId:'profile-test-claude',model:'test'}});assert.equal(response.status,200);assert.equal(calls.length,1);assert.equal(calls[0].client,'test-client');
});
