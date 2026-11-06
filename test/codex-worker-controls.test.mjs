import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StateStore } from '../dist/store.js';
import { renderCodexWorkerControls, updateCodexWorkerControls } from '../dist/codex-worker-controls.js';
import { OriginProtectionStore } from '../dist/origin-protection.js';
import { CodexPoolPolicyStore } from '../dist/codex-pool-policy.js';

test('worker controls save pool selection and bind the authenticated provider identity with revision fencing', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'rotoxy-controls-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const previous = process.env.ROTOXY_CONFIG_DIR;
  process.env.ROTOXY_CONFIG_DIR = dir;
  const store = new StateStore();
  if (previous === undefined) delete process.env.ROTOXY_CONFIG_DIR; else process.env.ROTOXY_CONFIG_DIR = previous;
  await store.init({ adminPassword: 'test-password' });
  const profileId = '11111111-1111-4111-8111-111111111111';
  await writeFile(join(dir, 'codex-profiles.json'), JSON.stringify({version:1,profiles:[{id:profileId}]}), {mode:0o600});
  await store.update(state => { state.oauthClients.push({clientId:'client-a',clientName:'Client <safe>',redirectUris:[],tokenEndpointAuthMethod:'none',createdAt:Date.now()}); });
  const profiles = {
    listProfiles: async () => [{id:profileId,label:'Native <profile>'}],
    listSnapshots: async () => [{profileId,accountIdentity:'hashed-provider-identity'}],
    refreshProfile: async () => ({profileId,authMode:'chatgpt',accountIdentity:'hashed-provider-identity'}),
  };
  const html = await renderCodexWorkerControls(store, profiles, '');
  assert.match(html, /Native &lt;profile&gt;/);
  assert.doesNotMatch(html, /Native <profile>/);
  await updateCodexWorkerControls(store, profiles, {action:'pool',enabled:'1',profile:profileId});
  assert.equal((await new CodexPoolPolicyStore(store).read()).dispatchEnabled, true);
  const notice = await updateCodexWorkerControls(store, profiles, {action:'bind',profileId,clientId:'client-a',sessionId:'session-one',revision:'0'});
  assert.match(notice, /Native account protected/);
  const origins = new OriginProtectionStore(store);
  assert.equal((await origins.evaluateSubscriptionDispatch({clientId:'client-a',sessionId:'session-one'}, profileId, 'hashed-provider-identity')).allowed, false);
  const binding = (await origins.listAdmin())[0];
  await assert.rejects(updateCodexWorkerControls(store, profiles, {action:'close',clientId:'client-a',sessionId:'session-one',revision:'0',bindingId:binding.bindingId}), /revision conflict/);
  await updateCodexWorkerControls(store, profiles, {action:'close',clientId:'client-a',sessionId:'session-one',revision:'1',bindingId:binding.bindingId});
  assert.equal((await origins.resolve({clientId:'client-a',sessionId:'session-one'})).resolved, false);
  await assert.rejects(updateCodexWorkerControls(store, profiles, {action:'bind',profileId,clientId:'unregistered',sessionId:'session-one',revision:'2'}), /client_unavailable/);
});
