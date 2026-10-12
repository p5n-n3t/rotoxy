import test from "node:test";
import assert from "node:assert/strict";
import { CredentialPool } from "../dist/pool.js";

test("trusted runtime registrations pin distinct sessions and cannot replace an established owner", () => {
  const pool = new CredentialPool({});
  assert.deepEqual(pool.registerSessionOwner("session-a", "account-a"), { ok: true, ownerAccountId: "account-a" });
  assert.deepEqual(pool.registerSessionOwner("session-b", "account-b"), { ok: true, ownerAccountId: "account-b" });
  assert.deepEqual(pool.registerSessionOwner("session-a", "account-b"), { ok: false, ownerAccountId: "account-a" });
  assert.equal(pool.ownership.sessionOwner("session-a"), "account-a");
  assert.equal(pool.ownership.sessionOwner("session-b"), "account-b");
});

test("trusted session registration rejects empty and unbounded bindings", () => {
  const pool = new CredentialPool({});
  assert.throws(() => pool.registerSessionOwner("", "account-a"), /invalid/);
  assert.throws(() => pool.registerSessionOwner("session-a", ""), /invalid/);
  assert.throws(() => pool.registerSessionOwner("s".repeat(257), "account-a"), /invalid/);
});
