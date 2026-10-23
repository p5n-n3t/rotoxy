#!/usr/bin/env node
/** Actual OAuth + Python-supervisor smoke with disposable state and zero providers. */
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {createServer} from 'node:http';
import {mkdtemp, mkdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {pathToFileURL, fileURLToPath} from 'node:url';

const root = process.argv[2] ? resolve(process.argv[2]) : fileURLToPath(new URL('../', import.meta.url));
const scratch = await mkdtemp(join(tmpdir(), 'rotoxy-fleet-oauth-'));
process.env.HOME = scratch;
process.env.ROTOXY_CONFIG_DIR = join(scratch, 'config');
process.env.TOKEN2OAUTH_CONFIG_DIR = process.env.ROTOXY_CONFIG_DIR;
const load = file => import(pathToFileURL(join(root, 'dist', file)).href);
let runtime, server, built;
try {
  const [{StateStore}, {createSupervisorRuntime}, {buildApp}, {pkceS256}] = await Promise.all([
    load('store.js'), load('supervisor-runtime.js'), load('server.js'), load('crypto.js'),
  ]);
  const store = new StateStore();
  const password = randomBytes(32).toString('base64url');
  await store.init({adminPassword:password});
  const configPath = join(scratch, 'supervisor.json');
  await writeFile(configPath, JSON.stringify({version:1,
    projects:[{projectId:'token2oauth',clientIds:[],accountIds:[],registeredSessions:[]}],
    sharedWorkspace:{projectId:'token2oauth',membership:'consented_oauth'},maxWorkers:1,
    allowUnknownQuota:true,localLimits:{maxTasks:10,maxJobBytes:65536,maxOutputBytes:4096}}), {mode:0o600});
  await mkdir(join(scratch, 'supervision'), {mode:0o700});
  runtime = await createSupervisorRuntime({store,configPath,configDir:store.dir,supervisorCwd:join(root,'supervisor'),
    supervisionDbPath:join(scratch,'supervision/inbox.sqlite'),recoveryDbPath:join(scratch,'supervision/recovery.sqlite'),
    oracleConfigPath:join(scratch,'oracle.json'),oracleDbPath:join(scratch,'oracle.sqlite')});
  built = await buildApp(store,{supervisorBackend:runtime,supervisorConfigPath:configPath});
  server = createServer(built.app);
  await new Promise((ok,fail)=>{server.once('error',fail);server.listen(0,'127.0.0.1',ok);});
  const base = `http://127.0.0.1:${server.address().port}`;
  await store.update(state=>{state.config.publicBaseUrl=base;state.config.basePath='';});
  const json = async response => {assert.ok(response.ok,`HTTP ${response.status}`);return response.json();};
  const registration = await json(await fetch(base+'/oauth/register',{method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({client_name:'Isolated fleet verification',redirect_uris:[base+'/callback']})}));
  const verifier = randomBytes(48).toString('base64url');
  const consent = await fetch(base+'/oauth/authorize',{method:'POST',redirect:'manual',headers:{'content-type':'application/x-www-form-urlencoded'},
    body:new URLSearchParams({client_id:registration.client_id,redirect_uri:base+'/callback',response_type:'code',
      code_challenge:pkceS256(verifier),code_challenge_method:'S256',resource:base+'/mcp',scope:'mcp jobs:read',admin_password:password})});
  assert.equal(consent.status,302);
  const code = new URL(consent.headers.get('location')).searchParams.get('code');
  const tokens = await json(await fetch(base+'/oauth/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},
    body:new URLSearchParams({grant_type:'authorization_code',client_id:registration.client_id,redirect_uri:base+'/callback',
      code,code_verifier:verifier,resource:base+'/mcp'})}));
  const mcp = async(name,args={})=>{
    const response = await json(await fetch(base+'/mcp',{method:'POST',headers:{authorization:`Bearer ${tokens.access_token}`,'content-type':'application/json'},
      body:JSON.stringify({jsonrpc:'2.0',id:name,method:'tools/call',params:{name,arguments:args}})}));
    assert.ok(!response.error && !response.result?.isError,`${name} failed`);
    return JSON.parse(response.result.content.find(part=>part.type==='text').text);
  };
  assert.deepEqual(await mcp('workspace_projects'),{projects:[{projectId:'token2oauth',label:'ROTOXY Fleet',kind:'fleet'}]});
  const snapshot = await mcp('workspace_snapshot',{projectId:'token2oauth'});
  assert.equal(snapshot.projectId,'token2oauth');
  assert.ok(Array.isArray(snapshot.tasks));
  console.log(JSON.stringify({passed:true,isolated:true,providerCalls:0,oauthPkce:true,fleetDiscovery:true,pythonWorkspaceSnapshot:true}));
} finally {
  if(server){server.closeAllConnections();await new Promise(ok=>server.close(ok));}
  await built?.codexProfiles?.close();
  await runtime?.close();
  await rm(scratch,{recursive:true,force:true});
}
