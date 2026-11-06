import test from 'node:test';
import assert from 'node:assert/strict';
import {chmod,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {StateStore} from '../dist/store.js';
import {CodexProfiles} from '../dist/codex-profiles.js';
import {OriginProtectionStore} from '../dist/origin-protection.js';

const CLIENT='cli-native-client';
const EMAIL='native-account@example.test';

function runCli(args, configDir, codexBinary){
 return execFileSync(process.execPath,[new URL('../dist/cli.js',import.meta.url).pathname,...args],{
  env:{...process.env,ROTOXY_CONFIG_DIR:configDir,...(codexBinary?{ROTOXY_CODEX_BINARY:codexBinary}:{})},
  encoding:'utf8',stdio:['ignore','pipe','pipe'],
 });
}

async function fixture(t,{authType='chatgpt'}={}){
 const root=await mkdtemp(join(tmpdir(),'rotoxy-codex-cli-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 const oldConfigDir=process.env.ROTOXY_CONFIG_DIR;
 const configDir=join(root,'config');process.env.ROTOXY_CONFIG_DIR=configDir;
 t.after(()=>{if(oldConfigDir===undefined)delete process.env.ROTOXY_CONFIG_DIR;else process.env.ROTOXY_CONFIG_DIR=oldConfigDir;});
 const store=new StateStore();await store.init({adminPassword:'temporary-codex-cli-test-password'});
 await store.update(state=>{state.oauthClients.push({clientId:CLIENT,clientName:'CLI test client',redirectUris:[],tokenEndpointAuthMethod:'none',createdAt:Date.now()});});
 const binary=join(root,'codex');
 const server=`#!/usr/bin/env node
const fs=require('node:fs');
const path=require('node:path');
const readline=require('node:readline');
const home=process.env.CODEX_HOME;
const log=(value)=>fs.appendFileSync(path.join(home,'cli-calls.jsonl'),value+'\\n');
const rl=readline.createInterface({input:process.stdin});
rl.on('line',(line)=>{let m;try{m=JSON.parse(line)}catch{return}log(m.method||'notification:'+String(m.method));if(!Object.hasOwn(m,'id'))return;let result={};switch(m.method){case 'account/read':result={account:{type:${JSON.stringify(authType)},planType:'plus',email:${JSON.stringify(EMAIL)}}};break;case 'model/list':result={data:[{id:'gpt-5.6-luna',supportedReasoningEfforts:['low','medium']}]};break;case 'account/rateLimits/read':result={rateLimitsByLimitId:{codex:{limitId:'codex',primary:{usedPercent:10},secondary:null}}};break;}process.stdout.write(JSON.stringify({id:m.id,result})+'\\n')});
process.on('SIGTERM',()=>{fs.writeFileSync(path.join(home,'cli-closed'),'closed');process.exit(0)});
`;
 await writeFile(binary,server,{mode:0o700});await chmod(binary,0o700);
 const profiles=new CodexProfiles({codexBinary:binary,configDir});
 const profile=await profiles.registerProfile('Native account');await profiles.close();
 return {root,configDir,binary,store,profile};
}

test('Codex pool CLI uses existing policy controls and preserves human plus JSON output',async t=>{
 const f=await fixture(t);
 const initial=JSON.parse(runCli(['codex-pool','status','--json'],f.configDir,f.binary));
 assert.equal(initial.dispatchEnabled,false);assert.equal(initial.profiles.length,1);assert.equal(initial.profiles[0].enabled,true);
 const human=runCli(['codex-pool','status'],f.configDir,f.binary);
 assert.match(human,/Codex dispatch: paused/);assert.match(human,new RegExp(f.profile.id));assert.doesNotMatch(human,/^\s*\{/);
 const enabled=JSON.parse(runCli(['codex-pool','enable','--json'],f.configDir,f.binary));
 assert.equal(enabled.dispatchEnabled,true);assert.equal(enabled.profiles[0].enabled,true);
 const disabled=JSON.parse(runCli(['codex-pool','disable','--json'],f.configDir,f.binary));
 assert.equal(disabled.dispatchEnabled,false);assert.equal(disabled.profiles[0].enabled,true);
 assert.equal(await readFile(join(f.profile.profileDir,'cli-calls.jsonl'),'utf8').catch(()=>''),'','pool policy commands must not open App Server transports');
});

test('codex-bind verifies official App Server identity, closes only its transport, and unbind is owner-bound',async t=>{
 const f=await fixture(t);
 const bindOutput=runCli(['codex-bind','--client-id',CLIENT,'--session-id','desktop-project-01','--native-profile',f.profile.id],f.configDir,f.binary);
 assert.match(bindOutput,/Native account protected/);assert.match(bindOutput,/Binding ID ([0-9a-f-]{36})/);
 assert.doesNotMatch(bindOutput,new RegExp(EMAIL));
 const origins=new OriginProtectionStore(f.store);const bindings=await origins.listAdmin();
 assert.equal(bindings.length,1);assert.equal(bindings[0].nativeProfileId,f.profile.id);assert.equal(bindings[0].closed,false);
 const calls=(await readFile(join(f.profile.profileDir,'cli-calls.jsonl'),'utf8')).trim().split('\n');
 assert.ok(calls.includes('account/read'));assert.ok(calls.includes('model/list'));assert.ok(calls.includes('account/rateLimits/read'));
 assert.equal(calls.some(method=>method.includes('thread/')||method.includes('turn/')),false,'binding is metadata-only and never starts inference');
 assert.equal(await readFile(join(f.profile.profileDir,'cli-closed'),'utf8'),'closed','CLI closes its temporary App Server transport');
 const output=runCli(['codex-unbind','--client-id',CLIENT,'--session-id','desktop-project-01','--binding-id',bindings[0].bindingId],f.configDir,f.binary);
 assert.match(output,/Session binding closed/);
 assert.equal((await origins.listAdmin())[0].closed,true);
});

test('codex-bind refuses a non-ChatGPT native identity and untrusted executable names',async t=>{
 const api=await fixture(t,{authType:'apiKey'});
 assert.throws(()=>runCli(['codex-bind','--client-id',CLIENT,'--session-id','session-api','--native-profile',api.profile.id],api.configDir,api.binary),error=>/profile_identity_unavailable/.test(error.stderr.toString()));
 assert.equal((await new OriginProtectionStore(api.store).listAdmin()).length,0);
 assert.throws(()=>runCli(['codex-bind','--client-id',CLIENT,'--session-id','session-api','--native-profile',api.profile.id,'--codex-binary','/bin/sh'],api.configDir,api.binary),error=>/codexBinary must be an absolute path to the trusted Codex binary/.test(error.stderr.toString()));
});
