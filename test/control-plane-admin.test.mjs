import test from 'node:test';import assert from 'node:assert/strict';import{mkdtemp,rm,readFile}from'node:fs/promises';import{tmpdir}from'node:os';import{join}from'node:path';
import{StateStore}from'../dist/store.js';import{buildApp}from'../dist/server.js';import{adminEpoch}from'../dist/admin-session.js';
test('unified admin keeps model keys private, enforces CSRF and preserves only an explicitly migrated bearer',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'rotoxy-control-test-'));const old={home:process.env.HOME,config:process.env.TOKEN2OAUTH_CONFIG_DIR};process.env.HOME=dir;process.env.TOKEN2OAUTH_CONFIG_DIR=join(dir,'gateway');let server;
 try{const store=new StateStore();await store.init({adminPassword:'admin-password-only-for-test'});const built=await buildApp(store);server=built.app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const base='http://127.0.0.1:'+server.address().port;await store.update(s=>{s.config.publicBaseUrl=base+'/edge'});const state=await store.load();const sid=built.sessions.create(undefined,adminEpoch(state)),csrf=built.sessions.csrfToken(sid),cookie='t2o_admin='+sid;
  const unauth=await fetch(base+'/admin/models',{redirect:'manual'});assert.equal(unauth.status,302);
  const post=(path,body)=>fetch(base+path,{method:'POST',redirect:'manual',headers:{cookie,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams(body)});
  assert.equal((await post('/admin/models/add',{label:'Key one',apiKey:'sensitive-model-api-key'})).status,403);
  const added=await post('/admin/models/add',{_csrf:csrf,label:'Key one',apiKey:'sensitive-model-api-key'});assert.equal(added.status,303);
  const html=await(await fetch(base+'/admin/models',{headers:{cookie}})).text();assert.match(html,/Key one/);assert.ok(!html.includes('sensitive-model-api-key'));assert.ok(!String(await readFile(join(store.dir,'model-credentials.json'))).includes('sensitive-model-api-key'));
  assert.ok(html.includes(base+'/edge/v1'));assert.ok(html.includes(base+'/edge/providers/ollama/v1'));assert.ok(html.includes(base+'/edge/providers/cloudflare/v1'));assert.ok(html.includes(base+'/edge/providers/openai/v1'));assert.ok(html.includes(base+'/edge/providers/openrouter/v1'));assert.ok(html.includes(base+'/edge/providers/custom-&lt;24-char-id&gt;/v1'));assert.ok(html.includes(base+'/edge/providers/claude/v1/messages'));assert.ok(html.includes(base+'/edge/mcp'));
  assert.match(html,/Pending; local Codex profiles do not provide inference dispatch/);assert.match(html,/Pending; Oracle worker pool inference is not exposed/);assert.match(html,/Unavailable; LightSprint is a workspace provider/);assert.match(html,/model:read/);assert.match(html,/model:invoke/);assert.match(html,/MCP OAuth/);assert.match(html,/admin password.*separate/i);assert.ok(!html.includes(base+'/providers/ollama/v1'));
  const issued=await post('/admin/models/token',{_csrf:csrf,scope:'invoke',days:'1'});assert.equal(issued.status,200);assert.equal(issued.headers.get('cache-control'),'no-store');const once=await issued.text();const token=/t2om_[A-Za-z0-9_-]+/.exec(once)?.[0];assert.ok(token);assert.equal(await built.modelGateway.credentials.authorizeToken(token,'model:invoke'),true);assert.ok(!(await(await fetch(base+'/admin/models',{headers:{cookie}})).text()).includes(token));
  assert.equal((await fetch(base+'/v1/models',{headers:{authorization:'Bearer admin-password-only-for-test'}})).status,401);
  const legacy='a'.repeat(64);assert.equal(await built.modelGateway.credentials.authorizeToken(legacy,'model:invoke'),false);const id=await built.modelGateway.credentials.importLegacyToken(legacy,Date.now()+86400000);assert.equal(await built.modelGateway.credentials.authorizeToken(legacy,'model:invoke'),true);await built.modelGateway.credentials.revokeToken(id);assert.equal(await built.modelGateway.credentials.authorizeToken(legacy,'model:invoke'),false);
  assert.equal((await fetch(base+'/admin/oracle',{redirect:'manual'})).status,302);
 }finally{if(server)await new Promise(r=>server.close(r));if(old.home===undefined)delete process.env.HOME;else process.env.HOME=old.home;if(old.config===undefined)delete process.env.TOKEN2OAUTH_CONFIG_DIR;else process.env.TOKEN2OAUTH_CONFIG_DIR=old.config;await rm(dir,{recursive:true,force:true});}
});

test('credit page shows recorded empty and unused balances for legacy LightSprint accounts', async()=>{
 const {CreditSnapshotStore}=await import('../dist/credit-snapshots.js');
 const dir=await mkdtemp(join(tmpdir(),'rotoxy-quota-page-'));
 const old={home:process.env.HOME,config:process.env.TOKEN2OAUTH_CONFIG_DIR};process.env.HOME=dir;process.env.TOKEN2OAUTH_CONFIG_DIR=join(dir,'gateway');let server;
 try{
  const store=new StateStore();await store.init({adminPassword:'test-quota-page',upstreamUrl:'https://app.lightsprint.ai/mcp'});
  const empty=await store.addAccount({label:'Depleted account',token:'test-only-empty'}),unused=await store.addAccount({label:'Unused account',token:'test-only-unused'});
  const ledger=new CreditSnapshotStore([empty,unused].map(a=>({provider:'lightsprint',accountId:a.id,label:a.label,unit:'credits'})),{directory:store.dir});
  for(const [a,remaining]of[[empty,0],[unused,10000000]])await ledger.recordBalanceSnapshot({auditId:'fixture-'+a.id,provider:'lightsprint',accountId:a.id,unit:'credits',remaining,observedAt:Date.now(),source:'user-reported',refreshDate:'2026-11-16'});
  const built=await buildApp(store);server=built.app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const base='http://127.0.0.1:'+server.address().port;
  const state=await store.load(),sid=built.sessions.create(undefined,adminEpoch(state));
  const response=await fetch(base+'/admin/credits',{headers:{cookie:'t2o_admin='+sid}}),html=await response.text();
  assert.equal(response.status,200);assert.match(html,/Depleted account/);assert.match(html,/Unused account/);assert.match(html,/100\.0%/);assert.match(html,/0\.0%/);assert.match(html,/2026-11-16/);assert.doesNotMatch(html,/Itscommmena and Maryjoebake estimates/);
 }finally{if(server)await new Promise(r=>server.close(r));if(old.home===undefined)delete process.env.HOME;else process.env.HOME=old.home;if(old.config===undefined)delete process.env.TOKEN2OAUTH_CONFIG_DIR;else process.env.TOKEN2OAUTH_CONFIG_DIR=old.config;await rm(dir,{recursive:true,force:true});}
});
