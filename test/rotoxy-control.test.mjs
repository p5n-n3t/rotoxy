import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Keep any future StateStore use in this test process away from operator data.
const isolatedHome = await mkdtemp(join(tmpdir(), 'rotoxy-home-'));
process.env.HOME = isolatedHome;
process.env.TOKEN2OAUTH_CONFIG_DIR = join(isolatedHome, '.config/token2oauth-test');

import { APP_UNITS, FUNNEL_UNIT, TARGET_UNIT, RotoxyController, formatLifecycleOutput, parseArgs } from '../scripts/rotoxy-control.mjs';

test.after(async () => { await rm(isolatedHome, { recursive: true, force: true }); });

function fixture({ health = true, initial = {} } = {}) {
  const active = new Set();
  let config = structuredClone(initial);
  const events = [];
  const runner = async (file, args) => {
    events.push([file, [...args]]);
    if (file === 'systemctl') {
      if (args[1] === 'show') return { code: 0, stdout: 'loaded' };
      if (args[1] === 'is-active') return active.has(args[2]) ? { code: 0, stdout: 'active\n' } : { code: 3, stdout: 'inactive\n' };
      const [, action, unit] = args;
      if (action === 'start') {
        active.add(unit);
        if (unit === FUNNEL_UNIT) {
          config = { ...config, Web: { ...(config.Web || {}), 'rotoxy.tailnet.ts.net:443': { Handlers: { ...(config.Web?.['rotoxy.tailnet.ts.net:443']?.Handlers || {}), '/': { Proxy: 'http://127.0.0.1:2030' } } } }, AllowFunnel: { ...(config.AllowFunnel || {}), 'rotoxy.tailnet.ts.net:443': true } };
        }
      } else {
        active.delete(unit);
        if (unit === FUNNEL_UNIT) {
          const hp = 'rotoxy.tailnet.ts.net:443';
          const handlers = { ...(config.Web?.[hp]?.Handlers || {}) };
          delete handlers['/'];
          const Web = { ...(config.Web || {}) };
          if (Object.keys(handlers).length) Web[hp] = { Handlers: handlers }; else delete Web[hp];
          const AllowFunnel = { ...(config.AllowFunnel || {}) };
          delete AllowFunnel[hp];
          config = { ...config, Web, AllowFunnel };
        }
      }
      return { code: 0, stdout: '' };
    }
    if (file === 'tailscale' && args[0] === 'serve' && args[1] === 'status') return { code: 0, stdout: JSON.stringify(config) };
    if (file === 'tailscale' && args.includes('off')) {
      const hp = Object.keys(config.Web || {}).find(k => k.endsWith(':443'));
      const Web = { ...(config.Web || {}) };
      const handlers = { ...(Web[hp]?.Handlers || {}) };
      delete handlers['/'];
      if (Object.keys(handlers).length) Web[hp] = { Handlers: handlers }; else delete Web[hp];
      config = { ...config, Web };
      if (args[0] === 'funnel') {
        const AllowFunnel = { ...(config.AllowFunnel || {}) };
        delete AllowFunnel[hp];
        config = { ...config, AllowFunnel };
      }
      return { code: 0, stdout: '' };
    }
    if (file === 'curl') return health ? { code: 0, stdout: 'ok' } : { code: 22, stderr: 'health unavailable' };
    throw new Error(`unexpected command ${file} ${args.join(' ')}`);
  };
  const controller = new RotoxyController(runner, { lockPath: join(isolatedHome, 'locks/control.lock'), healthAttempts: 2, sleep: async () => {} });
  return { controller, active, events, get config() { return config; } };
}

test('default health window leaves a bounded margin for normal gateway startup', () => {
  const controller = new RotoxyController(async () => ({ code: 0, stdout: '' }), { lockPath: join(isolatedHome, 'default-window.lock') });
  assert.equal(controller.healthAttempts, 180);
  assert.equal(controller.healthTimeoutMs, 90_000);
});

test('cold gateway can become healthy after 26 seconds without premature rollback', async () => {
  let elapsed = 0;
  let calls = 0;
  const controller = new RotoxyController(async () => {
    calls++;
    return { code: elapsed >= 26_000 ? 0 : 7, stdout: '' };
  }, { now: () => elapsed, sleep: async ms => { elapsed += ms; } });
  await controller.waitHealthy();
  assert.equal(elapsed, 26_000);
  assert.ok(calls > 30);
});

test('slow failed probes cannot stretch readiness beyond the bounded deadline', async () => {
  let elapsed = 0;
  let calls = 0;
  const controller = new RotoxyController(async () => {
    calls++;
    elapsed += 2_000;
    return { code: 28, stdout: '' };
  }, { now: () => elapsed, sleep: async ms => { elapsed += ms; } });
  await assert.rejects(controller.waitHealthy(), /health check within 90s.*journalctl/);
  assert.equal(elapsed, 90_000);
  assert.equal(calls, 36);
});

test('manual up health-checks before foreground Funnel and down withdraws only that unit', async () => {
  const initial = { Web: { 'rotoxy.tailnet.ts.net:443': { Handlers: { '/token2oauth': { Proxy: 'http://127.0.0.1:2030' } } } } };
  const f = fixture({ initial });
  const up = await f.controller.up();
  assert.equal(up.ok, true);
  assert.equal(f.config.Web['rotoxy.tailnet.ts.net:443'].Handlers['/'].Proxy, 'http://127.0.0.1:2030');
  const healthAt = f.events.findIndex(([file]) => file === 'curl');
  const funnelAt = f.events.findIndex(([file, args]) => file === 'systemctl' && args[1] === 'start' && args[2] === FUNNEL_UNIT);
  assert.ok(healthAt >= 0 && healthAt < funnelAt);
  assert.deepEqual(Object.keys(f.config.Web['rotoxy.tailnet.ts.net:443'].Handlers).sort(), ['/', '/token2oauth']);
  const startsBeforeRepeat = f.events.filter(([file, args]) => file === 'systemctl' && args[1] === 'start').length;
  assert.equal((await f.controller.up()).started.length, 0);
  assert.equal(f.events.filter(([file, args]) => file === 'systemctl' && args[1] === 'start').length, startsBeforeRepeat);
  const down = await f.controller.down();
  assert.equal(down.ok, true);
  assert.deepEqual(f.config.Web['rotoxy.tailnet.ts.net:443'].Handlers, { '/token2oauth': { Proxy: 'http://127.0.0.1:2030' } });
});

test('failed health check rolls back only units newly started by this call', async () => {
  const f = fixture({ health: false });
  await assert.rejects(f.controller.up(), /health check/);
  for (const unit of [TARGET_UNIT, ...APP_UNITS]) assert.equal(f.active.has(unit), false);
  assert.equal(f.events.some(([file, args]) => file === 'systemctl' && args[1] === 'start' && args[2] === FUNNEL_UNIT), false);
});

test('persistent Funnel is refused without broad Tailscale changes', async () => {
  const f = fixture({ initial: { Web: { 'rotoxy.tailnet.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:2025' } } } }, AllowFunnel: { 'rotoxy.tailnet.ts.net:443': true } } });
  await assert.rejects(f.controller.up({ migrationPlan: { version: 1, allowRemoveRoot: true, rootTarget: 'http://127.0.0.1:2025' } }), /Persistent\/active Funnel/);
  assert.equal(f.events.some(([file, args]) => file === 'tailscale' && args.includes('off')), false);
  assert.equal(f.active.size, 0);
});

test('a reviewed exact-target migration removes only root and preserves compatibility mount', async () => {
  const f = fixture({ initial: { Web: { 'rotoxy.tailnet.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:2025' }, '/token2oauth': { Proxy: 'http://127.0.0.1:2030' } } } } } });
  await assert.rejects(f.controller.up({ migrationPlan: { version: 1, allowRemoveRoot: true, rootTarget: 'http://127.0.0.1:9999' } }), /reviewed v1 migration plan/);
  assert.equal(f.events.some(([file]) => file === 'tailscale'), true);
  assert.equal(f.events.some(([file, args]) => file === 'tailscale' && args.includes('off')), false);
  const result = await f.controller.up({ migrationPlan: { version: 1, allowRemoveRoot: true, rootTarget: 'http://127.0.0.1:2025' } });
  assert.equal(result.ok, true);
  assert.deepEqual(Object.keys(f.config.Web['rotoxy.tailnet.ts.net:443'].Handlers).sort(), ['/', '/token2oauth']);
  const remove = f.events.find(([file, args]) => file === 'tailscale' && args.includes('off'));
  assert.deepEqual(remove[1], ['serve', '--https=443', '--set-path=/', 'off']);
});

test('approved persistent ROTOXY root migrates to the managed foreground Funnel and down withdraws it', async () => {
  const initial = { Web: { 'rotoxy.tailnet.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:2030' } } } }, AllowFunnel: { 'rotoxy.tailnet.ts.net:443': true }, TCP: { '8443': { TCPForward: 'localhost:8080' } } };
  const f = fixture({ initial });
  await assert.rejects(f.controller.up(), /Persistent\/active Funnel/);
  assert.equal(f.events.some(([file,args]) => file === 'tailscale' && args.includes('off')), false);
  const migrationPlan = { version: 1, allowRemoveRoot: true, allowRemovePersistentFunnel: true, rootTarget: 'http://127.0.0.1:2030' };
  assert.equal((await f.controller.up({migrationPlan})).ok, true);
  assert.deepEqual(f.events.find(([file,args]) => file === 'tailscale' && args[0] === 'funnel' && args.includes('off'))[1], ['funnel','--https=443','--set-path=/','off']);
  assert.deepEqual(f.config.TCP, initial.TCP);
  assert.equal((await f.controller.down()).ok,true);
  assert.deepEqual(f.config.TCP, initial.TCP);
});

test('persistent migration refuses a foreign mount even with the owned-root approval', async () => {
  const f = fixture({initial:{Web:{'rotoxy.tailnet.ts.net:443':{Handlers:{'/':{Proxy:'http://127.0.0.1:2030'},'/other':{Proxy:'http://127.0.0.1:9999'}}}},AllowFunnel:{'rotoxy.tailnet.ts.net:443':true}}});
  await assert.rejects(f.controller.up({migrationPlan:{version:1,allowRemoveRoot:true,allowRemovePersistentFunnel:true,rootTarget:'http://127.0.0.1:2030'}}), /Persistent\/active Funnel/);
  assert.equal(f.events.some(([file,args]) => file === 'tailscale' && args.includes('off')),false);
});

test('CLI accepts explicit human or JSON lifecycle output without loosening migration flags', () => {
  assert.deepEqual(parseArgs(['up']), { action: 'up', migrationPlan: undefined });
  assert.deepEqual(parseArgs(['up', '--migration-plan', '/tmp/review.json']), { action: 'up', migrationPlan: '/tmp/review.json' });
  assert.deepEqual(parseArgs(['status', '--json']), { action: 'status', migrationPlan: undefined, json: true });
  assert.deepEqual(parseArgs(['up', '--json', '--migration-plan', '/tmp/review.json']), { action: 'up', migrationPlan: '/tmp/review.json', json: true });
  assert.throws(() => parseArgs(['enable']), /Usage/);
  assert.throws(() => parseArgs(['status', '--migration-plan', 'x']), /only valid with up/);
  assert.throws(() => parseArgs(['up', '--json', '--json']), /Usage/);
  assert.throws(() => parseArgs(['down', '--migration-plan', 'x', '--json']), /only valid with up/);
});

test('human lifecycle output summarizes service states, readiness, ingress, and public route without dumping snapshots', () => {
  const result = { ok: true, started: ['rotoxy.target'], status: {
    units: { 'rotoxy-gateway.service': true, 'rotoxy-oracle-pool.service': false,
      'rotoxy-worker-monitor.service': true, 'rotoxy-funnel.service': true, 'rotoxy.target': true },
    configuredUnits: ['rotoxy-gateway.service', 'rotoxy-oracle-pool.service', 'rotoxy-worker-monitor.service'],
    root: 'http://127.0.0.1:2030', funnelAllowed: true, mounts: ['/','/token2oauth'],
    localReady: true, healthUrl: 'http://127.0.0.1:2030/healthz', publicRoute: 'https://rotoxy.tailnet.ts.net/', healthy: false,
    config: { hugeRawSnapshot: 'x'.repeat(10000) },
  } };
  const output = formatLifecycleOutput('up', result);
  assert.match(output, /ROTOXY started/);
  assert.match(output, /rotoxy-gateway\.service: active/);
  assert.match(output, /rotoxy-oracle-pool\.service: inactive/);
  assert.match(output, /Local readiness: ready/);
  assert.match(output, /Ingress: active; routes to the local gateway/);
  assert.match(output, /Public route: https:\/\/rotoxy\.tailnet\.ts\.net\//);
  assert.match(output, /Started by this command: rotoxy\.target/);
  assert.doesNotMatch(output, /hugeRawSnapshot|x{1000}/);
  assert.equal(formatLifecycleOutput('status', result.status).startsWith('ROTOXY status: needs attention'), true);
  assert.equal(formatLifecycleOutput('install-plan', { files: ['rotoxy.target'], installCommands: ['one'],
    wrapperBackup:'cp -a ...',wrapperSymlink: 'ln -sfn ...', migrationGate: 'review exact mappings' }),
  'ROTOXY install plan (manual; no unit is enabled at boot)\nFiles: rotoxy.target\nInstall steps: 1 commands\n  1. one\nBack up wrapper: cp -a ...\nWrapper: ln -sfn ...\nMigration gate: review exact mappings');
  assert.equal(formatLifecycleOutput('status', result.status, true), JSON.stringify(result.status, null, 2), '--json retains the full status object');
});

// Real Tailscale keeps non-background routes under a session-keyed Foreground map.
test('reads foreground routes and ignores session keys when verifying their withdrawal', async () => {
  const config = { Foreground: { 'session-a': { Web: { 'rotoxy.tailnet.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:2030' } } } }, TCP: { '443': { HTTPS: true } }, AllowFunnel: { 'rotoxy.tailnet.ts.net:443': true } } } };
  let current = config;
  const controller = new RotoxyController(async (file, args) => {
    if (file === 'tailscale') return { code: 0, stdout: JSON.stringify(current) };
    if (file === 'curl') return { code: 0, stdout: 'ok' };
    if (file === 'systemctl' && args[1] === 'show') return { code: 0, stdout: 'loaded' };
    if (file === 'systemctl' && args[1] === 'is-active') return { code: 0, stdout: 'active' };
    if (file === 'systemctl' && args[1] === 'stop') { if (args[2] === FUNNEL_UNIT) current = {}; return { code: 0, stdout: '' }; }
    throw Error('unexpected command');
  }, { lockPath: join(isolatedHome, 'foreground.lock') });
  assert.equal((await controller.status()).healthy, true);
  assert.equal((await controller.down()).ok, true);
});


test('manual Funnel lifecycle preserves exposure across backend restarts without boot activation', async () => {
  const {readFile}=await import('node:fs/promises');
  const unit=await readFile(new URL('../packaging/rotoxy-funnel.service',import.meta.url),'utf8');
  assert.match(unit,/^Wants=rotoxy-gateway\.service$/m);
  assert.match(unit,/^PartOf=rotoxy\.target$/m);
  assert.doesNotMatch(unit,/^(Requires|BindsTo|WantedBy)=/m);
  assert.match(unit,/^Restart=no$/m);
});

test('forwarded diagnostic failure preserves exit status without a second command dump', async () => {
  const {mkdir, writeFile} = await import('node:fs/promises');
  const {spawnSync} = await import('node:child_process');
  const prefix = join(isolatedHome, 'forwarded-cli');
  await mkdir(join(prefix, 'dist'), {recursive:true});
  await writeFile(join(prefix, 'dist/cli.js'), 'console.error("Configuration needs attention"); process.exitCode = 2;');
  const result = spawnSync(process.execPath, [new URL('../scripts/rotoxy-control.mjs',import.meta.url).pathname,'doctor'], {
    encoding:'utf8', env:{...process.env, ROTOXY_PREFIX:prefix}, timeout:10000,
  });
  assert.equal(result.status, 2);
  assert.equal(result.stderr.trim(), 'Configuration needs attention');
  assert.equal(result.stdout, '');
});
