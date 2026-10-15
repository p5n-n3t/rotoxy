import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runtimeStateRoot, SupervisorRuntime } from '../dist/supervisor-runtime.js';
import { OracleTools } from '../dist/oracle-tools.js';

async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), 'rotoxy-state-paths-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  return home;
}

test('fresh supervisor and Oracle state defaults to canonical ROTOXY state root', async (t) => {
  const home = await fixture(t);
  const root = join(home, '.local', 'state', 'rotoxy');
  assert.equal(runtimeStateRoot("oracle-pool", home), root);
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  try {
    let args;
    const tools = new OracleTools({ commandRunner: async (_command, actual) => { args = actual; return { exitCode: 0, stdout: '{"hosts":[]}' }; } });
    await tools.call('oracle_catalog', {}, 'client-a');
    assert.equal(args[3], join(root, 'oracle-pool', 'config.json'));
    assert.equal(args[5], join(root, 'oracle-pool', 'queue.sqlite3'));
  } finally { if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome; }
});

test('legacy state is reused in place until canonical state exists', async (t) => {
  const home = await fixture(t);
  const canonical = join(home, '.local', 'state', 'rotoxy');
  const legacy = join(home, '.local', 'state', 'token2oauth');
  await mkdir(join(legacy, 'supervision'), { recursive: true });
  await writeFile(join(legacy, 'supervision', 'recovery.sqlite3'), 'preserve');
  assert.equal(runtimeStateRoot("supervision", home), legacy);
  await mkdir(join(canonical, 'supervision'), { recursive: true });
  await writeFile(join(canonical, 'supervision', 'inbox.sqlite'), 'canonical');
  assert.equal(runtimeStateRoot("supervision", home), canonical);
});

test('a legacy Oracle database prevents construction from selecting a blank canonical database', async (t) => {
  const home = await fixture(t);
  const legacyDb = join(home, '.local', 'state', 'token2oauth', 'oracle-pool', 'queue.sqlite3');
  await mkdir(join(home, '.local', 'state', 'token2oauth', 'oracle-pool'), { recursive: true });
  await mkdir(join(home, '.local', 'state', 'rotoxy', 'supervision'), { recursive: true });
  await writeFile(join(home, '.local', 'state', 'rotoxy', 'supervision', 'inbox.sqlite'), 'separate subsystem');
  await writeFile(legacyDb, 'existing');
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  try {
    let args;
    const tools = new OracleTools({ commandRunner: async (_command, actual) => { args = actual; return { exitCode: 0, stdout: '{"hosts":[]}' }; } });
    await tools.call('oracle_catalog', {}, 'client-b');
    assert.equal(args[3], join(home, '.local', 'state', 'token2oauth', 'oracle-pool', 'config.json'));
    assert.equal(args[5], legacyDb);
  } finally { if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome; }
});

test('SupervisorRuntime uses discovered legacy state and preserves explicitly injected paths', async (t) => {
  const home = await fixture(t);
  const legacyDb = join(home, '.local', 'state', 'token2oauth', 'supervision', 'inbox.sqlite');
  await mkdir(join(home, '.local', 'state', 'token2oauth', 'supervision'), { recursive: true });
  await writeFile(legacyDb, 'existing');
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const runtimeConfig = { version: 1, projects: [], maxWorkers: 1, allowUnknownQuota: true, localLimits: { maxTasks: 1, maxJobBytes: 1024, maxOutputBytes: 1024 } };
    const store = { load: async () => ({ accounts: [], config: { upstreamUrl: '' } }) };
    const options = { configPath: join(home, 'supervisor.json'), configDir: join(home, 'config'), supervisorCwd: join(process.cwd(), 'supervisor'), store };
    const runtime = new SupervisorRuntime(runtimeConfig, options);
    assert.equal(runtime.supervisionDbPath, legacyDb);
    assert.equal(runtime.recoveryDbPath, join(home, '.local', 'state', 'token2oauth', 'supervision', 'recovery.sqlite3'));
    const exact = join(home, 'custom.sqlite');
    const explicit = new SupervisorRuntime(runtimeConfig, { ...options, supervisionDbPath: exact });
    assert.equal(explicit.supervisionDbPath, exact);
  } finally { if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome; }
});
