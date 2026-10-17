import tempfile
import unittest
from pathlib import Path

from snooze.supervisor_grants import GrantError, SupervisorGrantStore


class Clock:
    def __init__(self, now=1000):
        self.now = now

    def __call__(self):
        return self.now


class SupervisorGrantStoreTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / "private" / "grants.sqlite3"
        self.clock = Clock()
        self.store = SupervisorGrantStore(self.path, clock=self.clock)

    def issue(self, **updates):
        value = {
            "project": "project-a",
            "owner": "oauth-client:client-a",
            "remote_session": "lightsprint-session-a",
            "executor": "codex-cli",
            "executor_session": "0199a213-81c0-7800-8aa1-bbab2a035a53",
            "allowed_event_types": ["failed", "stalled"],
            "expires_at": self.clock.now + 120,
            "max_runtime_seconds": 60,
            "max_invocations": 1,
            "authorization": {
                "quota": "unknown",
                "mode": "owner-controlled-batch",
                "reference": "approval-42",
            },
        }
        value.update(updates)
        return self.store.issue(**value)

    def claim(self, grant, **updates):
        value = {
            "grant_id": grant["grantId"],
            "project": "project-a",
            "owner": "oauth-client:client-a",
            "remote_session": "lightsprint-session-a",
            "executor": "codex-cli",
            "executor_session": "0199a213-81c0-7800-8aa1-bbab2a035a53",
            "event_type": "failed",
        }
        value.update(updates)
        return self.store.claim(**value)

    def test_issue_records_explicit_unknown_quota_owner_authorization(self):
        grant = self.issue()
        self.assertEqual(grant["state"], "issued")
        self.assertEqual(grant["authorization"], {
            "quota": "unknown", "mode": "owner-controlled-batch", "reference": "approval-42",
        })
        self.assertNotIn("dollars", str(grant).lower())
        self.assertEqual(self.store.get(grant["grantId"]), grant)

    def test_claim_requires_exact_scope_and_allowed_event(self):
        grant = self.issue()
        with self.assertRaisesRegex(GrantError, "grant_scope_mismatch"):
            self.claim(grant, owner="oauth-client:other")
        with self.assertRaisesRegex(GrantError, "event_not_authorized"):
            self.claim(grant, event_type="needs_approval")
        claim = self.claim(grant)
        self.assertEqual(claim["state"], "claimed")
        self.assertEqual(claim["maxRuntimeSeconds"], 60)

    def test_expired_grant_is_terminal_and_cannot_be_claimed(self):
        grant = self.issue(expires_at=self.clock.now + 1)
        self.clock.now += 2
        with self.assertRaisesRegex(GrantError, "grant_expired"):
            self.claim(grant)
        self.assertEqual(self.store.get(grant["grantId"])["state"], "expired")

    def test_claim_is_durable_across_restart_and_never_replayed(self):
        grant = self.issue()
        claim = self.claim(grant)
        restarted = SupervisorGrantStore(self.path, clock=self.clock)
        with self.assertRaisesRegex(GrantError, "grant_already_claimed"):
            restarted.claim(
                grant_id=grant["grantId"], project="project-a", owner="oauth-client:client-a",
                remote_session="lightsprint-session-a", executor="codex-cli",
                executor_session="0199a213-81c0-7800-8aa1-bbab2a035a53", event_type="failed",
            )
        self.assertEqual(restarted.get(grant["grantId"])["claimId"], claim["claimId"])

    def test_finish_is_idempotent_but_never_reissues_ambiguous_claim(self):
        grant = self.issue()
        claim = self.claim(grant)
        finished = self.store.finish(grant_id=grant["grantId"], claim_id=claim["claimId"], outcome="ambiguous",
                                    receipt={"adapter": "codex-exec-resume", "state": "execution-ambiguous", "raw": "discard"})
        self.assertEqual(finished["state"], "ambiguous")
        self.assertNotIn("raw", str(finished))
        self.assertEqual(self.store.finish(grant_id=grant["grantId"], claim_id=claim["claimId"], outcome="ambiguous",
                                           receipt={"adapter": "codex-exec-resume", "state": "execution-ambiguous"}), finished)
        with self.assertRaisesRegex(GrantError, "grant_already_claimed"):
            self.claim(grant)

    def test_invalid_authorization_cannot_claim_measured_quota_or_money(self):
        with self.assertRaisesRegex(GrantError, "invalid_authorization"):
            self.issue(authorization={"quota": "available", "mode": "owner-controlled-batch", "reference": "approval-42"})
        with self.assertRaisesRegex(GrantError, "invalid_authorization"):
            self.issue(authorization={"quota": "unknown", "mode": "owner-controlled-batch", "reference": "approval-42", "budgetUsd": 1})
        with self.assertRaisesRegex(GrantError, "invalid_max_invocations"):
            self.issue(max_invocations=2)


if __name__ == "__main__":
    unittest.main()
