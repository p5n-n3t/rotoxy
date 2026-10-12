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
