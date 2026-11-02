import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createServer } from 'node:http';
import { mkdtemp,rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { StateStore } from '../dist/store.js';
import { CredentialPool } from '../dist/pool.js';
import { McpProxy } from '../dist/proxy.js';
import { McpJobEventsError } from '../dist/mcp-job-events.js';

test('MCP events stay local, scope gated, opt-in, and never disclose callback secrets in errors',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'rotoxy-events-proxy-'));
  const old=process.env.ROTOXY_CONFIG_DIR;process.env.ROTOXY_CONFIG_DIR=dir;
  const store=new StateStore();
  if(old===undefined)delete process.env.ROTOXY_CONFIG_DIR;else process.env.ROTOXY_CONFIG_DIR=old;
  await store.init({adminPassword:'synthetic-events-proxy-password'});
  let scope='mcp jobs:read',called=0,fail=false,enabled=true;
  const events={async call(method,params,clientId){called++;assert.equal(clientId,'event-test-client');if(fail)throw new McpJobEventsError(-32015,'secret-callback-value','challenge_failed');return {events:[{name:'rotoxy.job.changed'}]};}};
  const proxy=new McpProxy(store,new CredentialPool(store),undefined,undefined,undefined,undefined,undefined,events);
  const disabled=new McpProxy(store,new CredentialPool(store));
  const app=express();app.use(express.raw({type:'application/json'}));
  // Authentication middleware is deliberately injected for this protocol unit
  // test; the production server mounts its existing OAuth authenticator first.
  app.use((req,res,next)=>{res.locals.oauthClaims={client_id:'event-test-client',scope};next();});
  app.all('/mcp',(req,res)=>(enabled?proxy:disabled).handler(req,res));
  const server=createServer(app);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true});});
  const rpc=body=>fetch(`http://127.0.0.1:${server.address().port}/mcp`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  const request={jsonrpc:'2.0',id:1,method:'events/list',params:{}};
  const discovery=await(await rpc({jsonrpc:'2.0',id:2,method:'initialize',params:{protocolVersion:'2025-06-18'}})).json();
  assert.deepEqual(discovery.result.capabilities.events,{});
  assert.equal((await(await rpc(request)).json()).result.events[0].name,'rotoxy.job.changed');
  assert.equal(called,1);
  scope='mcp';
  assert.equal((await rpc(request)).status,403);
  assert.equal(called,1);
  const unscopedInit=await(await rpc({jsonrpc:'2.0',id:3,method:'initialize',params:{}})).json();
  assert.equal(unscopedInit.result.capabilities.events,undefined);
  scope='mcp jobs:read';fail=true;
  const rejected=await(await rpc({...request,method:'events/subscribe',params:{delivery:{secret:'secret-callback-value'}}})).json();
  assert.equal(rejected.error.code,-32015);
  assert.equal(rejected.error.data.reason,'challenge_failed');
  assert.doesNotMatch(JSON.stringify(rejected),/secret-callback-value/);
  const before=called;
  assert.equal((await rpc([request,request])).status,400);
  assert.equal(called,before);
  enabled=false;
  assert.equal((await(await rpc(request)).json()).error.code,-32601);
  enabled=true;fail=false;
  let framing='json';
  const upstream=createServer((req,res)=>{
    const chunks=[];req.on('data',chunk=>chunks.push(chunk));req.on('end',()=>{
      const message=JSON.parse(Buffer.concat(chunks).toString());
      const reply={jsonrpc:'2.0',id:message.id,result:{protocolVersion:'2025-06-18',capabilities:{resources:{subscribe:true},tools:{listChanged:true}},serverInfo:{name:'synthetic-upstream',version:'1'}}};
      res.setHeader('content-type',framing==='sse'?'text/event-stream':'application/json');
      res.end(framing==='sse'?`data: ${JSON.stringify(reply)}\n\n`:JSON.stringify(reply));
    });
  });
  await new Promise(resolve=>upstream.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{upstream.closeAllConnections();await new Promise(resolve=>upstream.close(resolve));});
  await store.update(state=>{state.config.upstreamUrl=`http://127.0.0.1:${upstream.address().port}/mcp`;});
  await store.addAccount({label:'Synthetic upstream',token:'synthetic-upstream-account-key'});
  for(const kind of ['json','sse']){
    framing=kind;
    const response=await rpc({jsonrpc:'2.0',id:7,method:'initialize',params:{protocolVersion:'2025-06-18'}});
    const text=await response.text();
    assert.equal(response.status,200,text);
    const reply=JSON.parse(kind==='sse'?text.split('\n').find(line=>line.startsWith('data: ')).slice(6):text);
    assert.deepEqual(reply.result.capabilities.events,{});
    assert.deepEqual(reply.result.capabilities.resources,{subscribe:true});
    assert.equal(reply.result.serverInfo.name,'synthetic-upstream');
  }
});
