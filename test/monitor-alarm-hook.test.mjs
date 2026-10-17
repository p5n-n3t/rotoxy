import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { runDesktopAlarm } from '../scripts/desktop-alarm-hook.mjs';

function childProcess() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.killedWith = undefined;
  child.kill = (signal) => { child.killedWith = signal; };
  return child;
}

const config = { sourceDb: '/private/recovery.sqlite3', receiptsDb: '/private/alarms.sqlite3' };

test('desktop alarm invokes the fixed bounded module and returns its structured receipt', async () => {
  const child = childProcess();
  let invocation;
  const resultPromise = runDesktopAlarm({ config, root: '/opt/rotoxy',
    spawnProcess: (...args) => { invocation = args; return child; } });
  child.stdout.end('scanned=8 submitted=7 failed=1 ambiguous=0\n');
  child.emit('close', 1);

  assert.deepEqual(invocation[0], '/usr/bin/python3');
  assert.deepEqual(invocation[1], ['-m', 'snooze.desktop_alarm', '--source-db', config.sourceDb,
    '--receipts-db', config.receiptsDb]);
  assert.equal(invocation[2].cwd, '/opt/rotoxy');
  assert.equal(invocation[2].env.PYTHONPATH, '/opt/rotoxy/supervisor');
  assert.equal(invocation[2].shell, false);
  assert.deepEqual(invocation[2].stdio, ['ignore', 'pipe', 'ignore']);
  assert.deepEqual(await resultPromise,
    { status: 'attention_required', scanned: 8, submitted: 7, failed: 1, ambiguous: 0 });
});

test('an alarm command failure returns a sanitized summary without exposing stderr', async () => {
  const child = childProcess();
  const resultPromise = runDesktopAlarm({ config, root: '/opt/rotoxy',
    spawnProcess: () => child });
  child.stdout.end('private stack trace and token\n');
  child.emit('close', 2);
  const result = await resultPromise;
  assert.deepEqual(result,
    { status: 'failed', scanned: 0, submitted: 0, failed: 0, ambiguous: 0, error: 'command_failed' });
  assert.equal(JSON.stringify(result).includes('token'), false);
});

test('alarm timeout terminates the child and records uncertainty without throwing', async () => {
  const child = childProcess();
  let timer;
  const resultPromise = runDesktopAlarm({ config, root: '/opt/rotoxy', spawnProcess: () => child,
    setTimer: (callback, ms) => { assert.equal(ms, 60_000); timer = callback; return 1; },
    clearTimer: () => {} });
  timer();
  assert.equal(child.killedWith, 'SIGKILL');
  assert.deepEqual(await resultPromise,
    { status: 'failed', scanned: 0, submitted: 0, failed: 0, ambiguous: 1, error: 'timeout' });
});

test('invalid alarm paths are rejected before spawning', async () => {
  let invoked = false;
  const result = await runDesktopAlarm({ config: { ...config, sourceDb: 'relative.sqlite3' }, root: '/opt/rotoxy',
    spawnProcess: () => { invoked = true; throw new Error('must not run'); } });
  assert.equal(invoked, false);
  assert.equal(result.error, 'invalid_config');
});

test('out of range receipt counters are discarded as an invalid receipt', async () => {
  const child = childProcess();
  const resultPromise = runDesktopAlarm({ config, root: '/opt/rotoxy', spawnProcess: () => child });
  child.stdout.end('scanned=101 submitted=101 failed=0 ambiguous=0\n');
  child.emit('close', 0);
  assert.equal((await resultPromise).error, 'invalid_receipt');
});
