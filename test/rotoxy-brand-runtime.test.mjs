import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { APP_UNITS, forwardCli, RotoxyController } from '../scripts/rotoxy-control.mjs';

const home = await mkdtemp(join(tmpdir(), 'rotoxy-brand-'));
process.env.HOME = home;
process.env.ROTOXY_CONFIG_DIR = join(home, 'config');
delete process.env.TOKEN2OAUTH_CONFIG_DIR;
const { configDir, defaultConfig } = await import('../dist/store.js');
test.after(async () => { await rm(home, { recursive: true, force: true }); });

test('ROTOXY config override wins; legacy override remains supported', async () => {
  process.env.ROTOXY_CONFIG_DIR = '~/canonical';
  process.env.TOKEN2OAUTH_CONFIG_DIR = '~/legacy-explicit';
  assert.equal(configDir(), join(home, 'canonical'));
  delete process.env.ROTOXY_CONFIG_DIR;
  assert.equal(configDir(), join(home, 'legacy-explicit'));
});

test('existing legacy store is discovered before canonical initialization; canonical store wins once present', async () => {
  delete process.env.TOKEN2OAUTH_CONFIG_DIR;
  const legacy = join(home, '.config', 'token2oauth');
  await mkdir(legacy, { recursive: true });
  await writeFile(join(legacy, 'state.json'), '{}');
  assert.equal(configDir(), legacy);
  const canonical = join(home, '.config', 'rotoxy');
  await mkdir(canonical, { recursive: true });
  await writeFile(join(canonical, 'state.json'), '{}');
  assert.equal(configDir(), canonical);
});

test('new defaults use ROTOXY root URL and preserve legacy env compatibility', () => {
  delete process.env.ROTOXY_CONFIG_DIR;
  delete process.env.TOKEN2OAUTH_CONFIG_DIR;
  delete process.env.ROTOXY_BASE_PATH;
  delete process.env.TOKEN2OAUTH_BASE_PATH;
  delete process.env.ROTOXY_PUBLIC_BASE_URL;
  delete process.env.TOKEN2OAUTH_PUBLIC_BASE_URL;
  assert.equal(configDir(), join(home, '.config', 'rotoxy'));
  assert.equal(defaultConfig().basePath, '');
  assert.equal(defaultConfig().publicBaseUrl, 'http://127.0.0.1:2030');
  process.env.TOKEN2OAUTH_BASE_PATH = '/old-prefix';
  assert.equal(defaultConfig().basePath, '/old-prefix');
  process.env.ROTOXY_BASE_PATH = '/new-prefix';
  assert.equal(defaultConfig().basePath, '/new-prefix');
});

test('lifecycle inventory uses canonical ROTOXY service units and templates stay manual', async () => {
  assert.deepEqual(APP_UNITS, ['rotoxy-gateway.service', 'rotoxy-oracle-pool.service', 'rotoxy-worker-monitor.service']);
  const ctl = new RotoxyController(async () => ({ code: 0, stdout: 'inactive' }), { lockPath: join(home, 'lock') });
  const plan = ctl.installPlan(home);
  assert.ok(plan.files.includes('rotoxy-gateway.service'));
  assert.ok(plan.files.includes('rotoxy-oracle-pool.service'));
  assert.ok(plan.files.includes('rotoxy-worker-monitor.service'));
  for (const name of APP_UNITS) {
    const text = await (await import('node:fs/promises')).readFile(new URL(`../packaging/${name}`, import.meta.url), 'utf8');
    assert.doesNotMatch(text, /^\[Install\]/m);
    assert.doesNotMatch(text, /^WantedBy=/m);
  }
});

test('wrapper forwards argument arrays to trusted installed dist entrypoint without shell', async () => {
  const prefix = join(home, 'trusted prefix');
  await mkdir(join(prefix, 'dist'), { recursive: true });
  await writeFile(join(prefix, 'dist', 'cli.js'), '#!/usr/bin/env node\n');
  let call;
  forwardCli(['account', 'add', '--label', 'a; touch /tmp/should-not-run'], {
    prefix,
    runner: (file, args) => { call = { file, args }; },
  });
  assert.equal(call.file, process.execPath);
  assert.deepEqual(call.args, [join(prefix, 'dist', 'cli.js'), 'account', 'add', '--label', 'a; touch /tmp/should-not-run']);
});
