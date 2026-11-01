import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createServer} from 'node:http';
import {StateStore} from '../dist/store.js';
import {buildApp} from '../dist/server.js';
import {pkceS256} from '../dist/crypto.js';

test('search OAuth is audience-isolated and exposes only permissioned Oracle search/fetch',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'rotoxy-search-oauth-'));const old=process.env.ROTOXY_CONFIG_DIR;process.env.ROTOXY_CONFIG_DIR=dir;
 const store=new StateStore();const password='synthetic-search-test-password';await store.init({adminPassword:password});
 const calls=[];
 const webTools={definitionsFor:async(client,scopes)=>[
   ...(scopes.has('web:search')?[{name:'web_search',inputSchema:{properties:{provider:{enum:['exa','oracle']}}}}]:[]),
   ...(scopes.has('web:extract')?[{name:'web_extract',inputSchema:{properties:{provider:{enum:['oracle']}}}}]:[])],
  call:async(name,args,client)=>{calls.push({name,args,client});return {provider:'oracle',results:[{url:'https://example.com'}]};}};
 const built=await buildApp(store,{webTools});const server=createServer(built.app);await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
 t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));if(old===undefined)delete process.env.ROTOXY_CONFIG_DIR;else process.env.ROTOXY_CONFIG_DIR=old;await rm(dir,{recursive:true,force:true});});
 await store.update(s=>{s.config.publicBaseUrl=base;s.config.basePath='';s.config.upstreamUrl='';});
 const rpc=(path,token,method,params={})=>fetch(base+path,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+token},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});
 const unauth=await fetch(base+'/search/mcp',{method:'POST'});assert.equal(unauth.status,401);assert.match(unauth.headers.get('www-authenticate'),/oauth-protected-resource\/search\/mcp/);
 const metadata=await(await fetch(base+'/.well-known/oauth-protected-resource/search/mcp')).json();assert.equal(metadata.resource,base+'/search/mcp');assert.ok(!metadata.scopes_supported.includes('jobs:write'));
 async function token(path,scope){
  const redirect=base+'/callback';const c=await(await fetch(base+'/oauth/register',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({client_name:'search-check',redirect_uris:[redirect]})})).json();const v='s'.repeat(64);
  const consent=await fetch(base+'/oauth/authorize',{method:'POST',redirect:'manual',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:c.client_id,redirect_uri:redirect,response_type:'code',code_challenge:pkceS256(v),code_challenge_method:'S256',resource:base+path,scope,admin_password:password})});
  if(consent.status!==302)return {status:consent.status};
  const code=new URL(consent.headers.get('location')).searchParams.get('code');const r=await fetch(base+'/oauth/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'authorization_code',client_id:c.client_id,redirect_uri:redirect,code,code_verifier:v,resource:base+path})});return {status:r.status,...await r.json()};
 }
 const search=await token('/search/mcp','mcp web:search');assert.equal(search.status,200);
 const init=await(await rpc('/search/mcp',search.access_token,'initialize',{protocolVersion:'2025-11-25'})).json();assert.match(init.result.instructions,/untrusted/);
 const list=await(await rpc('/search/mcp',search.access_token,'tools/list')).json();assert.deepEqual(list.result.tools.map(x=>x.name),['search']);
 const result=await(await rpc('/search/mcp',search.access_token,'tools/call',{name:'search',arguments:{query:'test'}})).json();assert.equal(result.result.isError,false);assert.equal(calls[0].args.provider,'oracle');
 for(const name of ['fetch','job_submit','oracle_submit'])assert.ok((await(await rpc('/search/mcp',search.access_token,'tools/call',{name,arguments:{}})).json()).error);
 assert.equal((await rpc('/mcp',search.access_token,'tools/list')).status,401);
 const main=await token('/mcp','mcp web:search');assert.equal((await rpc('/search/mcp',main.access_token,'tools/list')).status,401);
 assert.equal((await token('/search/mcp','mcp jobs:write')).status,400);
 assert.equal(calls.length,1);
});
