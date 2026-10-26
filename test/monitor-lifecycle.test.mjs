import assert from 'node:assert/strict';
import test from 'node:test';
import { childExitState } from '../scripts/monitor-lifecycle.mjs';

test('monitor classifies a child interrupted during an orderly shutdown as stopped', () => {
  assert.equal(childExitState(true, null, 'SIGTERM'), 'stopped');
  assert.equal(childExitState(true, 137, null), 'stopped');
});

test('monitor retains failure classification when it is not shutting down', () => {
  assert.equal(childExitState(false, 0, null), 'completed');
  assert.equal(childExitState(false, 1, null), 'failed');
  assert.equal(childExitState(false, null, 'SIGKILL'), 'failed');
});
