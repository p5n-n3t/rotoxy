import test from "node:test";
import assert from "node:assert/strict";
import { normalizeParkedQuestion } from "../dist/worker-observation.js";

test("normalizes only bounded provider question content", () => {
  assert.deepEqual(normalizeParkedQuestion({ id: "q-1", text: "Choose a target", choices: ["A", "B"], kind: "approval", privatePrompt: "ignored" }), {
    id: "q-1", text: "Choose a target", choices: ["A", "B"], source: "provider", kind: "approval",
  });
});

test("redacts credential-like content and leaves unknown shapes unknown", () => {
  assert.deepEqual(normalizeParkedQuestion({ text: "Set api_key=abc123 before proceeding" }), {
    text: "Set [redacted] before proceeding", source: "provider", kind: "question",
  });
  assert.equal(normalizeParkedQuestion({ payload: { raw: "private" } }), undefined);
  assert.equal(normalizeParkedQuestion("unknown provider shape"), undefined);
});

test("rejects oversized and malformed question projections without truncation", () => {
  assert.equal(normalizeParkedQuestion({ text: "x".repeat(3000) }), undefined);
  assert.equal(normalizeParkedQuestion({ text: "Confirm", choices: ["ok", 4] }), undefined);
  assert.equal(normalizeParkedQuestion({ text: "Confirm", choices: Array(13).fill("x") }), undefined);
});

import { normalizeSessionObservation } from '../dist/worker-observation.js';

test('idle with provider relay error is a failure, without leaking the error message', () => {
  const status = normalizeSessionObservation({
    sessionStatus: 'idle', errorCode: 'ACP_RELAY_DIED',
    errorMessage: 'access_token=do-not-store',
  });
  assert.deepEqual(status, { state: 'failed', errorCode: 'ACP_RELAY_DIED', needsInput: false });
  assert.equal(JSON.stringify(status).includes('do-not-store'), false);
});

test('native approval remains separate from ordinary guidance', () => {
  const status = normalizeSessionObservation({
    sessionStatus: 'idle', parkedQuestion: { kind: 'approval', text: 'Approve?' },
  });
  assert.equal(status.state, 'idle');
  assert.equal(status.needsInput, true);
  assert.equal(status.question.kind, 'approval');
});

test('invalid error codes and terminal states fail closed', () => {
  assert.equal(normalizeSessionObservation({ sessionStatus: 'idle', errorCode: 'secret=credential' }).errorCode, 'provider_execution_error');
  assert.equal(normalizeSessionObservation({ sessionStatus: 'timeout' }).state, 'timed_out');
  assert.equal(normalizeSessionObservation({ sessionStatus: 'interrupted' }).state, 'failed');
  assert.equal(normalizeSessionObservation({ sessionStatus: 'idle' }).state, 'idle');
});

test("normalization preserves supported legacy status fields", () => {
  assert.equal(normalizeSessionObservation({status:"idle"}).state,"idle");
  assert.equal(normalizeSessionObservation({state:"running"}).state,"running");
  assert.equal(normalizeSessionObservation({status:"idle",errorCode:"ACP_RELAY_DIED"}).state,"failed");
});
