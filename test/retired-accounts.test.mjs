import test from 'node:test';
import assert from 'node:assert/strict';
import {CredentialPool} from '../dist/pool.js';
import {retiredAccount,activeAccountState} from '../dist/retired-providers.js';
import {refreshAccountCapabilities,toolCatalog} from '../dist/capabilities.js';

test('retired credentials never appear in counts or inventories and cannot be probed',async()=>{
 const retired={id:'retired',label:'Legacy',provider:'lightsprint',enabled:true,stats:{state:'healthy'}};
 const active={id:'active',label:'Search',provider:'exa',enabled:true,stats:{state:'healthy'}};
 const state={config:{upstreamUrl:''},accounts:[retired,active],capabilities:{retired:{tools:[{name:'legacy_tool',schemaHash:'x'}]},active:{tools:[]}}};
 let reveals=0;
 const store={load:async()=>state,revealToken:async()=>{reveals++;throw Error('must not read secret');}};
 const pool=new CredentialPool(store);
 assert.deepEqual(pool.snapshot(state).map(a=>a.id),['active']);
 assert.deepEqual(activeAccountState(state).accounts.map(a=>a.id),['active']);
 assert.deepEqual(toolCatalog(state),[]);
 assert.equal((await pool.probeAccount('retired')).error,'provider_retired');
 assert.equal((await refreshAccountCapabilities(store,'retired')).error,'provider_retired');
 assert.equal(reveals,0);
 assert.equal(pool.isCompatibleAccount(retired,state),false);
});
test('legacy generic credentials are retired only for the retired provider origin',()=>{
 const account={provider:'generic-bearer-mcp'};
 assert.equal(retiredAccount(account,{config:{upstreamUrl:'https://app.lightsprint.ai/mcp'}}),true);
 assert.equal(retiredAccount(account,{config:{upstreamUrl:'https://other.example/mcp'}}),false);
});
