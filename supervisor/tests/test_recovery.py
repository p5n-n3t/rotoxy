import json
import tempfile
import unittest
from pathlib import Path

from snooze.recovery import RecoveryEngine, RecoveryError


class Clock:
    def __init__(self): self.now = 1000
    def __call__(self): return self.now
    def advance(self, seconds): self.now += seconds


class FakeOracle:
    def __init__(self): self.calls = []
    def submit(self, text, **kwargs):
        self.calls.append((text, kwargs))
        return {"id": kwargs["job_id"], "status": "queued"}


class RecoveryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.db = Path(self.temp.name) / "private" / "recovery.sqlite"
        self.clock = Clock()
        self.calls = []
        self.engine = RecoveryEngine(self.db, adapters={"pause": self.action}, clock=self.clock)
        self.policy()
        self.engine.register_session(scope="scope-a", project="project-a", job="job-a",
            account="acct-a", session="session-a", adapter="codex")

    def policy(self, **updates):
        value = {"level": "rules", "permissions": ["rule:pause"], "rules": {"failed": "pause"},
            "max_attempts": 2, "max_runtime_seconds": 5, "action_budget_usd": 0,
            "budget_ceiling_usd": 0, "oracle_advice": False, "oracle_hourly_limit": 0,
            "headless_adapter_verified": False}
        value.update(updates)
        return self.engine.configure("scope-a", value)

    def event(self, *, event_id="incident-1", kind="failed", severity="high", account="acct-a", session="session-a", job="job-a"):
        return self.engine.ingest({"event_id": event_id, "scope": "scope-a", "project": "project-a",
            "job": job, "kind": kind, "severity": severity, "account": account, "session": session})

    def action(self, context, timeout):
        self.calls.append((dict(context), timeout))
        return {"state": "accepted", "receipt": {"adapter": "pause", "request_id": context["event_id"],
            "unsafe": "this field must not persist"}}

    def test_event_dedup_and_registered_session_affinity_execute_once(self):
        first = self.event()
        duplicate = self.event()
        self.assertFalse(first["deduplicated"])
        self.assertTrue(duplicate["deduplicated"])
        result = self.engine.run("incident-1")
        self.assertEqual(result["state"], "completed")
        self.assertEqual(self.calls[0][0]["account"], "acct-a")
        self.assertEqual(self.calls[0][0]["session"], "session-a")
        self.assertEqual(self.engine.run("incident-1")["state"], "completed")
        self.assertEqual(len(self.calls), 1)
        self.assertNotIn("unsafe", str(self.engine.get("incident-1")))

    def test_event_id_conflict_and_unregistered_affinity_fail_closed(self):
        self.event()
        with self.assertRaisesRegex(RecoveryError, "event_id_conflict"):
            self.event(kind="stalled")
        self.event(event_id="other", session="unregistered")
        result = self.engine.run("other")
        self.assertEqual(result["state"], "handoff")
        self.assertEqual(result["decision"]["reason"], "registered_session_binding_missing")
        self.assertEqual(self.calls, [])

    def test_permission_and_rule_registry_gate_before_action(self):
        self.policy(permissions=[])
        self.event()
        result = self.engine.run("incident-1")
        self.assertEqual(result["state"], "handoff")
        self.assertEqual(result["decision"]["reason"], "action_not_permitted")
        self.assertEqual(self.calls, [])
        self.policy(permissions=["rule:missing"], rules={"stalled": "missing"})
        self.event(event_id="incident-2", kind="stalled")
        self.assertEqual(self.engine.run("incident-2")["decision"]["reason"], "registered_rule_unavailable")

    def test_only_verified_not_started_action_can_be_explicitly_retried(self):
        tries = []
        def retryable(context, timeout):
            tries.append(context["attempt"])
            return {"state": "rejected", "definitely_not_started": True}
        self.engine.adapters["pause"] = retryable
        self.event()
        first = self.engine.run("incident-1")
        self.assertEqual(first["state"], "retryable")
        second = self.engine.run("incident-1")
        self.assertEqual(second["state"], "handoff")
        self.assertEqual(tries, [1, 2])

    def test_crash_after_claim_becomes_ambiguous_and_never_replays(self):
        self.event()
        with self.engine.connection(write=True) as db:
            db.execute("UPDATE recovery_events SET state='claimed',updated=? WHERE event_id='incident-1'", (self.clock.now,))
            db.execute("INSERT INTO recovery_actions(event_id,action,attempt,state,started) VALUES('incident-1','pause',1,'claimed',?)", (self.clock.now,))
        self.clock.advance(20)
        resumed = RecoveryEngine(self.db, adapters={"pause": self.action}, clock=self.clock)
        result = resumed.run("incident-1")
        self.assertEqual(result["state"], "ambiguous")
        self.assertEqual(resumed.run("incident-1")["state"], "ambiguous")
        self.assertEqual(self.calls, [])

    def test_rule_action_timeout_has_a_durable_receipt_and_is_never_replayed(self):
        calls = []
        def side_effect_then_timeout(context, timeout):
            calls.append(context["event_id"])
            raise TimeoutError("receipt lost after safe action")
        self.engine.adapters["pause"] = side_effect_then_timeout
        self.event()
        self.assertEqual(self.engine.run("incident-1")["state"], "ambiguous")
        reopened = RecoveryEngine(self.db, adapters={"pause": side_effect_then_timeout}, clock=self.clock)
        self.assertEqual(reopened.run("incident-1")["state"], "ambiguous")
        self.assertEqual(calls, ["incident-1"])
        self.assertEqual(reopened.get("incident-1")["action"]["error_code"], "adapter_ambiguous")

    def test_headless_fails_closed_without_verification_permission_or_budget_evidence(self):
        def headless(context, timeout):
            self.calls.append(context)
            return {"state": "accepted"}
        self.engine.adapters["headless"] = headless
        verifier_calls = []
        self.engine.resource_verifier = lambda context: verifier_calls.append(context) or {
            "verified": True, "quota": "available", "budgetVerified": True,
            "project": context["project"], "job": context["job"], "account": context["account"],
            "session": context["session"], "observedAt": self.clock.now, "availableBudgetUsd": 1}
        self.policy(level="headless", permissions=["headless"], action_budget_usd=0.25,
                    budget_ceiling_usd=1, headless_adapter_verified=False)
        self.event()
        result = self.engine.run("incident-1")
        self.assertEqual(result["decision"]["reason"], "headless_adapter_unverified")
        self.assertEqual(self.calls, [])
        self.policy(level="headless", permissions=["headless"], action_budget_usd=0.25,
                    budget_ceiling_usd=1, headless_adapter_verified=True)
        self.event(event_id="incident-2")
        self.engine.resource_verifier = None
        self.assertEqual(self.engine.run("incident-2")["decision"]["reason"], "resource_verifier_unavailable")
        self.assertEqual(self.calls, [])

    def test_codex_headless_advisory_survives_the_durable_receipt_filter(self):
        def headless(context, timeout):
            return {"state": "accepted", "receipt": {
                "adapter": "codex-exec-resume", "state": "turn-completed",
                "advisory": "Check evidence. Bearer secret-value api_key=topsecret",
                "advisoryOnly": True, "advisoryTruncated": False,
                "rawTranscript": "must not persist",
            }}
        self.engine.adapters["headless"] = headless
        self.engine.resource_verifier = lambda context: {
            "verified": True, "quota": "available", "budgetVerified": True,
            "project": context["project"], "job": context["job"], "account": context["account"],
            "session": context["session"], "observedAt": self.clock.now, "availableBudgetUsd": 1,
        }
        self.policy(level="headless", permissions=["headless"], action_budget_usd=0.25,
                    budget_ceiling_usd=1, headless_adapter_verified=True)
        self.event()
        self.assertEqual(self.engine.run("incident-1")["state"], "completed")
        action = self.engine.get("incident-1")["action"]
        receipt = json.loads(action["receipt"])
        self.assertEqual(receipt["adapter"], "codex-exec-resume")
        self.assertEqual(receipt["advisory"], "Check evidence. Bearer [REDACTED] api_key=[REDACTED]")
        self.assertTrue(receipt["advisoryOnly"])
        self.assertNotIn("rawTranscript", receipt)
        self.assertNotIn("secret-value", json.dumps(receipt))
        self.assertNotIn("topsecret", json.dumps(receipt))

    def test_chatgpt_target_and_human_level_remain_durable_handoffs(self):
        self.engine.adapters["headless"] = self.action
        self.engine.register_session(scope="scope-a", project="project-a", job="job-web",
            account="acct-web", session="web-session", adapter="chatgpt_web")
        self.policy(level="headless", permissions=["headless"], action_budget_usd=0.25,
                    budget_ceiling_usd=1, headless_adapter_verified=True)
        self.event(event_id="web-event", account="acct-web", session="web-session", job="job-web")
        self.assertEqual(self.engine.run("web-event")["decision"]["reason"], "headless_adapter_unsupported")
        self.policy(level="human", permissions=[])
        self.event(event_id="human-event")
        result = self.engine.run("human-event")
        self.assertEqual(result["state"], "handoff")
        self.assertEqual([row["event_id"] for row in self.engine.pending_handoffs(scope="scope-a")], ["web-event", "human-event"])

    def test_ambiguous_paid_action_holds_budget_and_is_not_replayed(self):
        paid_calls = []
        def cloud(context, timeout):
            paid_calls.append(context)
            raise TimeoutError("receipt lost")
        self.engine.adapters["cloud-supervisor"] = cloud
        self.engine.resource_verifier = lambda c: {"verified": True, "quota": "available", "budgetVerified": True,
            "project": c["project"], "job": c["job"], "account": c["account"],
            "session": c["session"], "observedAt": self.clock.now, "availableBudgetUsd": 1}
        self.policy(level="cloud-supervisor", permissions=["cloud-supervisor"], action_budget_usd=0.25,
                    budget_ceiling_usd=0.50)
        self.event()
        result = self.engine.run("incident-1")
        self.assertEqual(result["state"], "ambiguous")
        self.assertTrue(result["decision"]["budgetHeld"])
        self.assertEqual(self.engine.run("incident-1")["state"], "ambiguous")
        with self.engine.connection() as db:
            self.assertEqual(tuple(db.execute("SELECT reserved_cents,spent_cents FROM recovery_budget WHERE scope='scope-a'").fetchone()), (25, 0))
        self.assertEqual(len(paid_calls), 1)

    def test_oracle_advice_is_significant_only_deduplicated_and_never_executed(self):
        oracle = FakeOracle()
        engine = RecoveryEngine(self.db, adapters={"pause": self.action}, oracle_pool=oracle, clock=self.clock)
        engine.configure("scope-a", {"level": "observe", "permissions": [], "rules": {}, "max_attempts": 1,
            "max_runtime_seconds": 5, "action_budget_usd": 0, "budget_ceiling_usd": 0,
            "oracle_advice": True, "oracle_hourly_limit": 2, "headless_adapter_verified": False})
        self.engine = engine
        self.event()
        result = engine.run("incident-1")
        self.assertEqual(result["advice"]["state"], "queued")
        engine.run("incident-1")
        self.assertEqual(len(oracle.calls), 1)
        self.assertIn("Do not execute actions", oracle.calls[0][0])
        self.event(event_id="routine", kind="running")
        self.assertEqual(engine.request_advice("routine")["reason"], "incident_not_significant")
        self.assertEqual(self.calls, [])


if __name__ == "__main__":
    unittest.main()
