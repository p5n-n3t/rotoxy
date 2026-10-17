import { spawn as nodeSpawn } from 'node:child_process';
import { isAbsolute, resolve } from 'node:path';

const PYTHON = '/usr/bin/python3';
const MAX_STDOUT_BYTES = 16 * 1024;
const TIMEOUT_MS = 60_000;
const MAX_EVENTS_PER_PASS = 100;
const SUMMARY_RE = /^scanned=(\d+) submitted=(\d+) failed=(\d+) ambiguous=(\d+)\s*$/;

function failed(error) {
  return { status: 'failed', scanned: 0, submitted: 0, failed: 0, ambiguous: 0, error };
}

export function runDesktopAlarm({ config, root, spawnProcess = nodeSpawn,
  setTimer = setTimeout, clearTimer = clearTimeout }) {
  if (!config || typeof config.sourceDb !== 'string' || typeof config.receiptsDb !== 'string' ||
      !isAbsolute(config.sourceDb) || !isAbsolute(config.receiptsDb) || typeof root !== 'string' || !isAbsolute(root)) {
    return Promise.resolve(failed('invalid_config'));
  }

  return new Promise((resolveResult) => {
    let child;
    try {
      child = spawnProcess(PYTHON, ['-m', 'snooze.desktop_alarm', '--source-db', config.sourceDb,
        '--receipts-db', config.receiptsDb], {
        cwd: root,
        env: { ...process.env, PYTHONPATH: resolve(root, 'supervisor') },
        shell: false,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch {
      resolveResult(failed('launch_failed'));
      return;
    }

    let stdout = '';
    let stdoutBytes = 0;
    let finished = false;
    const finish = (summary) => {
      if (finished) return;
      finished = true;
      clearTimer(timer);
      resolveResult(summary);
    };
    const timer = setTimer(() => {
      child.kill('SIGKILL');
      finish({ ...failed('timeout'), ambiguous: 1 });
    }, TIMEOUT_MS);

    child.stdout?.on('data', (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_STDOUT_BYTES) {
        child.kill('SIGKILL');
        finish(failed('output_limit'));
        return;
      }
      stdout += chunk.toString('utf8');
    });
    child.on('error', () => finish(failed('launch_failed')));
    child.on('close', (code) => {
      if (finished) return;
      const match = SUMMARY_RE.exec(stdout);
      if (!match) {
        finish(failed(code === 0 ? 'invalid_receipt' : 'command_failed'));
        return;
      }
      const [, scanned, submitted, failedCount, ambiguous] = match.map(Number);
      if (![scanned, submitted, failedCount, ambiguous].every(Number.isSafeInteger) ||
          [scanned, submitted, failedCount, ambiguous].some((value) => value > MAX_EVENTS_PER_PASS) ||
          submitted + failedCount + ambiguous > scanned) {
        finish(failed('invalid_receipt'));
        return;
      }
      const hasFailures = failedCount > 0 || ambiguous > 0 || code !== 0;
      finish({ status: hasFailures ? 'attention_required' : 'completed', scanned, submitted,
        failed: failedCount, ambiguous, ...(code !== 0 && failedCount === 0 && ambiguous === 0
          ? { error: 'command_failed' } : {}) });
    });
  });
}
