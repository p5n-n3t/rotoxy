#!/usr/bin/env node
import { realpathSync, statSync, existsSync } from "node:fs";
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { open, mkdir, stat, unlink, utimes } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const APP_UNITS = Object.freeze([
  'rotoxy-gateway.service', 'rotoxy-oracle-pool.service',
  'rotoxy-worker-monitor.service',
]);
export const FUNNEL_UNIT = 'rotoxy-funnel.service';
export const TARGET_UNIT = 'rotoxy.target';
export const MANAGED_UNITS = Object.freeze([...APP_UNITS, FUNNEL_UNIT, TARGET_UNIT]);
export const LOCAL_HEALTH = 'http://127.0.0.1:2030/healthz';
const execFileAsync = promisify(execFile);
const MAX_COMMAND_MS = 12_000;

export function createExecFileRunner(timeout = MAX_COMMAND_MS) {
  return async (file, args = []) => {
    if (!['systemctl', 'tailscale', 'curl'].includes(file)) throw new Error(`command not allowlisted: ${file}`);
    try {
      const env = { ...process.env };
      if (process.platform === 'linux' && !env.DBUS_SESSION_BUS_ADDRESS && process.getuid) {
        const runtime = `/run/user/${process.getuid()}`;
        try { const bus = statSync(`${runtime}/bus`); if (bus.isSocket() && bus.uid === process.getuid()) { env.XDG_RUNTIME_DIR ||= runtime; env.DBUS_SESSION_BUS_ADDRESS = `unix:path=${runtime}/bus`; } } catch {}
      }
      const out = await execFileAsync(file, args, { env, timeout, maxBuffer: 256 * 1024, encoding: 'utf8' });
      return { code: 0, stdout: out.stdout || '', stderr: out.stderr || '' };
    } catch (error) {
      return { code: Number.isInteger(error?.code) ? error.code : 1, stdout: error?.stdout || '', stderr: error?.stderr || error?.message || '' };
    }
  };
}

const canonical = v => JSON.stringify(sort(v));
function sort(v) {
  if (Array.isArray(v)) return v.map(sort);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map(k => [k, sort(v[k])]));
  return v;
}
function parseServe(text) {
  let v;
  try { v = JSON.parse(text || '{}'); } catch { throw new Error('Tailscale Serve status was not valid JSON'); }
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('Tailscale Serve status must be an object');
  return v;
}
function layers(config) { return [config, ...Object.values(config.Foreground || {})]; }
function webState(config) {
  const ports = layers(config).flatMap(layer => Object.entries(layer.Web || {}).filter(([key]) => key.endsWith(':443')).map(([hostPort, server]) => ({ hostPort, server, layer })));
  if (ports.length > 1) throw new Error('Multiple Tailscale HTTPS listeners exist; refusing ambiguous routing');
  const { hostPort, server, layer } = ports[0] || {};
  const handlers = server?.Handlers || {};
  return { hostPort, handlers, root: handlers['/'], funnelAllowed: Boolean(hostPort && layer.AllowFunnel?.[hostPort]) };
}
function unrelatedSnapshot(config) {
  const view = structuredClone(config);
  delete view.ETag;
  for (const layer of layers(view)) {
    for (const key of Object.keys(layer.Web || {})) {
      if (!key.endsWith(':443')) continue;
      if (layer.AllowFunnel) delete layer.AllowFunnel[key];
      const handlers = layer.Web[key].Handlers || {};
      if (handlers['/']?.Proxy === 'http://127.0.0.1:2030') delete handlers['/'];
      if (!Object.keys(handlers).length) { delete layer.Web[key]; if (layer.TCP?.['443'] && !layer.TCP['443'].TCPForward) delete layer.TCP['443']; }
    }
    for (const key of ['Web', 'TCP', 'AllowFunnel']) if (layer[key] && !Object.keys(layer[key]).length) delete layer[key];
  }
  for (const [key, layer] of Object.entries(view.Foreground || {})) if (!Object.keys(layer).length) delete view.Foreground[key];
  if (view.Foreground && !Object.keys(view.Foreground).length) delete view.Foreground;
  return canonical(view);
}

async function acquireLock(lockPath, waitMs = 10_000) {
  await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });
  const end = Date.now() + waitMs;
  while (Date.now() < end) {
    try {
      const handle = await open(lockPath, 'wx', 0o600);
      await handle.writeFile(`${process.pid}\n`);
      const heartbeat = setInterval(() => { const now = new Date(); void utimes(lockPath, now, now).catch(() => {}); }, 10_000);
      heartbeat.unref();
      return async () => { clearInterval(heartbeat); await handle.close(); await unlink(lockPath).catch(() => {}); };
    } catch (e) {
      if (e?.code !== 'EEXIST') throw e;
      try { if (Date.now() - (await stat(lockPath)).mtimeMs > 30_000) { await unlink(lockPath); continue; } }
      catch (statError) { if (statError?.code === 'ENOENT') continue; }
      await new Promise(r => setTimeout(r, 100));
    }
  }
  throw new Error('Timed out waiting for another rotoxy lifecycle operation');
}

export class RotoxyController {
  constructor(runner = createExecFileRunner(), options = {}) {
    this.run = runner;
    this.healthUrl = options.healthUrl || LOCAL_HEALTH;
    this.lockPath = options.lockPath || resolve(homedir(), '.local/state/rotoxy/control.lock');
    this.sleep = options.sleep || (ms => new Promise(r => setTimeout(r, ms)));
    this.healthAttempts = options.healthAttempts || 20;
  }
  async command(file, args) {
    const result = await this.run(file, args);
    if (!result || !Number.isInteger(result.code)) throw new Error(`Invalid command runner result for ${file}`);
    return result;
  }
  async active(unit) {
    const r = await this.command('systemctl', ['--user', 'is-active', unit]);
    return r.code === 0 && r.stdout.trim() === 'active';
  }
  async inspect() {
    const r = await this.command('tailscale', ['serve', 'status', '--json']);
    if (r.code !== 0) throw new Error(`Could not inspect Tailscale Serve state: ${r.stderr.trim()}`);
    const config = parseServe(r.stdout);
    const stable = structuredClone(config);
    delete stable.ETag;
    return { config, ...webState(config), fingerprint: canonical(stable) };
  }
  async appUnits() {
    const units = [APP_UNITS[0]];
    for (const unit of APP_UNITS.slice(1)) {
      const r = await this.command("systemctl", ["--user", "show", unit, "--property=LoadState", "--value"]);
      if (r.code === 0 && r.stdout.trim() === "loaded") units.push(unit);
    }
    return units;
  }
  async status() {
    const units = {};
    for (const unit of MANAGED_UNITS) units[unit] = await this.active(unit);
    const route = await this.inspect();
    const configuredUnits = await this.appUnits();
    return { units, configuredUnits, root: route.root?.Proxy || null, funnelAllowed: route.funnelAllowed,
      mounts: Object.keys(route.handlers).sort(), healthy: configuredUnits.every(unit => units[unit]) && units[FUNNEL_UNIT] && route.root?.Proxy === 'http://127.0.0.1:2030' && route.funnelAllowed };
  }
  async waitHealthy() {
    for (let i = 0; i < this.healthAttempts; i++) {
      const r = await this.command('curl', ['--fail', '--silent', '--show-error', '--max-time', '2', this.healthUrl]);
      if (r.code === 0) return;
      await this.sleep(500);
    }
    throw new Error(`Token2OAuth did not pass ${this.healthUrl} health check`);
  }
  async runUnit(action, unit) {
    if (!MANAGED_UNITS.includes(unit)) throw new Error(`Refusing unmanaged unit ${unit}`);
    if (!['start', 'stop'].includes(action)) throw new Error(`Refusing systemctl action ${action}`);
    const r = await this.command('systemctl', ['--user', action, unit]);
    if (r.code !== 0) throw new Error(`systemctl ${action} ${unit} failed: ${r.stderr.trim()}`);
  }
  async up(options = {}) {
    const release = await acquireLock(this.lockPath);
    const started = [];
    try {
      const before = await this.inspect();
      let baselineFingerprint = before.fingerprint;
      const appUnits = await this.appUnits();
      const backendsActive = (await Promise.all(appUnits.map(unit => this.active(unit)))).every(Boolean);
      if (await this.active(FUNNEL_UNIT) && before.root?.Proxy === 'http://127.0.0.1:2030' && before.funnelAllowed && backendsActive) {
        await this.waitHealthy();
        return { ok: true, started: [], status: await this.status() };
      }
      if (before.funnelAllowed) throw new Error('Persistent/active Funnel configuration exists. Complete an explicit migration plan and withdraw it before up; global Tailscale resets are not supported.');
      if (Object.keys(before.handlers).some(p => p !== '/' && p !== '/token2oauth')) {
        throw new Error('Foreign Tailscale mounts exist; review and migrate them explicitly before starting the single-root Funnel');
      }
      if (before.handlers['/token2oauth'] && before.handlers['/token2oauth'].Proxy !== 'http://127.0.0.1:2030') throw new Error('Existing /token2oauth mount does not target the expected compatibility server');
      if (before.root) {
        const plan = options.migrationPlan;
        if (typeof before.root.Proxy !== 'string' || !plan || plan.version !== 1 || plan.allowRemoveRoot !== true || plan.rootTarget !== before.root.Proxy) {
          throw new Error(`Root route is occupied by ${String(before.root.Proxy || 'a non-proxy handler')}; pass a reviewed v1 migration plan matching its exact target to remove this route.`);
        }
        const expected = JSON.parse(before.fingerprint);
        if (!before.hostPort || !expected.Web?.[before.hostPort]?.Handlers?.['/']) throw new Error('Cannot identify the approved root handler in the observed snapshot');
        delete expected.Web[before.hostPort].Handlers['/'];
        if (!Object.keys(expected.Web[before.hostPort].Handlers).length) delete expected.Web[before.hostPort];
        const removed = await this.command('tailscale', ['serve', '--https=443', '--set-path=/', 'off']);
        if (removed.code !== 0) throw new Error(`Could not remove the explicitly approved root route: ${removed.stderr.trim()}`);
        const migrated = await this.inspect();
        const observedExpected = structuredClone(migrated.config);
        delete observedExpected.ETag;
        if (canonical(observedExpected) !== canonical(expected) || migrated.root) throw new Error('Tailscale state changed beyond the approved root route during migration; refusing further changes');
        baselineFingerprint = migrated.fingerprint;
      }
      if (!await this.active(TARGET_UNIT)) { await this.runUnit('start', TARGET_UNIT); started.push(TARGET_UNIT); }
      for (const unit of appUnits) {
        if (!await this.active(unit)) { await this.runUnit('start', unit); started.push(unit); }
      }
      await this.waitHealthy();
      const current = await this.inspect();
      if (current.fingerprint !== baselineFingerprint) throw new Error('Tailscale routes changed during startup; refusing exposure');
      if (!await this.active(FUNNEL_UNIT)) { await this.runUnit('start', FUNNEL_UNIT); started.push(FUNNEL_UNIT); }
      let after = await this.inspect();
      for (let attempt = 0; attempt < 20 && (after.root?.Proxy !== 'http://127.0.0.1:2030' || !after.funnelAllowed); attempt++) {
        await this.sleep(250); after = await this.inspect();
      }
      if (after.root?.Proxy !== 'http://127.0.0.1:2030' || !after.funnelAllowed) throw new Error('Foreground Funnel did not produce the expected root route to 127.0.0.1:2030');
      return { ok: true, started, status: await this.status() };
    } catch (error) {
      const rollbackErrors = [];
      for (const unit of started.reverse()) try { await this.runUnit('stop', unit); } catch (e) { rollbackErrors.push(String(e.message || e)); }
      if (rollbackErrors.length) error.message += `; rollback issues: ${rollbackErrors.join('; ')}`;
      throw error;
    } finally { await release(); }
  }
  async down() {
    const release = await acquireLock(this.lockPath);
    try {
      const before = await this.inspect();
      if (before.root && before.root.Proxy !== 'http://127.0.0.1:2030') throw new Error(`Foreign root route ${String(before.root.Proxy || 'non-proxy handler')}; refusing to alter it`);
      if (Object.keys(before.handlers).some(p => p !== '/' && p !== '/token2oauth')) throw new Error('Foreign Tailscale mounts exist; refusing to stop the ROTOXY Funnel');
      if (before.handlers['/token2oauth'] && before.handlers['/token2oauth'].Proxy !== 'http://127.0.0.1:2030') throw new Error('Existing /token2oauth mount does not target the expected compatibility server');
      if (before.root && !await this.active(FUNNEL_UNIT)) throw new Error('Persistent root route exists without the owned foreground Funnel unit; explicit migration required');
      const unrelatedBefore = unrelatedSnapshot(before.config);
      if (await this.active(FUNNEL_UNIT)) await this.runUnit('stop', FUNNEL_UNIT);
      const after = await this.inspect();
      if (after.root?.Proxy === 'http://127.0.0.1:2030' || after.funnelAllowed) throw new Error('Funnel route remains after stopping the owned foreground unit; no global route reset was attempted');
      if (unrelatedSnapshot(after.config) !== unrelatedBefore) throw new Error('Unrelated Tailscale state changed while stopping the foreground Funnel; backend units were left running');
      if (await this.active(TARGET_UNIT)) await this.runUnit('stop', TARGET_UNIT);
      for (const unit of [...await this.appUnits()].reverse()) if (await this.active(unit)) await this.runUnit('stop', unit);
      return { ok: true, status: await this.status() };
    } finally { await release(); }
  }
  installPlan(home = homedir()) {
    const dir = `${home}/.config/systemd/user`;
    const lib = `${home}/.local/lib/rotoxy-control.mjs`;
    return { mode: 'manual; no unit is enabled at boot', files: ['rotoxy.target', ...APP_UNITS, FUNNEL_UNIT],
      installCommands: [`install -Dm644 packaging/rotoxy.target ${dir}/rotoxy.target`, ...APP_UNITS.map(unit => `install -Dm644 packaging/${unit} ${dir}/${unit}`), `install -Dm644 packaging/${FUNNEL_UNIT} ${dir}/${FUNNEL_UNIT}`, `install -Dm755 scripts/rotoxy-control.mjs ${lib}`, 'systemctl --user daemon-reload'],
      wrapperBackup: `if [ -e ${home}/.local/bin/rotoxy ] || [ -L ${home}/.local/bin/rotoxy ]; then cp -a ${home}/.local/bin/rotoxy ${home}/.local/bin/rotoxy.pre-rotoxy-control; fi`,
      wrapperSymlink: `ln -sfn ${lib} ${home}/.local/bin/rotoxy`,
      migrationGate: 'Inspect tailscale serve status --json and tailscale funnel status. Remove only reviewed owned mappings; provide explicit operator migration authorization. The controller never executes a global reset/off.' };
  }
}

export function forwardCli(argv, options = {}) {
  let prefix = options.prefix || process.env.ROTOXY_PREFIX || process.env.TOKEN2OAUTH_PREFIX;
  if (!prefix) {
    const installedLink = resolve(homedir(), '.local/bin/rotoxy-cli');
    if (existsSync(installedLink)) {
      const target = realpathSync(installedLink);
      if (target.endsWith('/dist/cli.js')) prefix = resolve(target, '../../');
    }
  }
  prefix ||= `${homedir()}/.local/share/rotoxy`;
  prefix = resolve(prefix);
  const cli = resolve(prefix, 'dist/cli.js');
  if (!existsSync(cli)) throw new Error(`ROTOXY CLI is not installed at ${cli}`);
  const runner = options.runner || ((file, args) => execFileSync(file, args, { stdio: 'inherit', env: options.env || process.env }));
  return runner(process.execPath, [cli, ...argv]);
}

export function parseArgs(argv) {
  const action = argv[0];
  if (!['up', 'down', 'status', 'install-plan'].includes(action)) throw new Error('Usage: rotoxy-control.mjs {up|down|status|install-plan} [--migration-plan file]');
  let migrationPlan;
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] !== '--migration-plan' || !argv[i + 1] || migrationPlan) throw new Error('Usage: rotoxy-control.mjs up [--migration-plan file]');
    migrationPlan = argv[++i];
  }
  if (migrationPlan && action !== 'up') throw new Error('--migration-plan is only valid with up');
  return { action, migrationPlan };
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    const argv = process.argv.slice(2);
    if (!['up', 'down', 'status', 'install-plan'].includes(argv[0])) { forwardCli(argv); process.exit(0); }
    const { action, migrationPlan } = parseArgs(argv);
    const controller = new RotoxyController();
    let result;
    if (action === 'up') {
      let plan;
      if (migrationPlan) {
        const { readFile } = await import('node:fs/promises');
        plan = JSON.parse(await readFile(migrationPlan, 'utf8'));
      }
      result = await controller.up({ migrationPlan: plan });
    }
    else if (action === 'down') result = await controller.down();
    else if (action === 'status') result = await controller.status();
    else result = controller.installPlan();
    console.log(JSON.stringify(result, null, 2));
  } catch (error) { console.error(error?.message || error); process.exitCode = 1; }
}
