import json
import tempfile
import unittest
from contextlib import closing
from pathlib import Path

from snooze.bridge import create_job_registry
from snooze.credit_admission import CreditAdmission
from snooze.credit_ledger import CreditDenied, CreditLedger
from snooze.jobs import JobRegistry


def task(account="account-a"):
    return {
        "taskId": "task-1", "dependsOn": [], "scopeKeys": ["path:src/one.py"],
        "instructions": "Return one short summary", "execution": {
            "mode": "existing-session", "sessionId": "session-a", "accountId": account,
        }, "output": {"kind": "text", "maxBytes": 1024, "format": "plain", "expectedMarker": "DONE"},
    }


def assignment():
    return {
        "schemaVersion": 1, "assignmentId": "assignment-a", "idempotencyKey": "once",
        "projectId": "project-a", "eligibleAccountIds": ["account-a"], "tasks": [task()],
    }


class CreditAdmissionIntegrationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.state = self.root / "state"
        self.state.mkdir(mode=0o700)
        self.config = self.state / "credit-admission.json"
        self.ledger_path = self.state / "credit-reservations.sqlite3"
        self.db_path = self.state / "snooze.sqlite3"
        self.policy = {
            "schemaVersion": 1, "enabled": True,
            "accounts": {"account-a": {
                "userId": "JQ", "provider": "lightsprint", "unit": "credits",
                "cycleId": "2026-11", "costUpperBound": 100,
                "boundVerified": True, "boundSource": "provider-enforced per-task cap evidence",
                "verifiedDebitSources": ["provider debit receipt"],
            }},
        }
        self.write_config()
        self.admission = CreditAdmission.from_private_config(self.config, self.ledger_path)
        self.registry = JobRegistry(self.db_path, credit_admission=self.admission)
        self.register_and_submit(self.registry)

    def tearDown(self):
        self.temp.cleanup()

    def write_config(self):
        self.config.write_text(json.dumps(self.policy), encoding="utf-8")
        self.config.chmod(0o600)

    @staticmethod
    def register_and_submit(registry):
        registry.register_account({
            "accountId": "account-a", "enabled": True, "authorized": True,
            "allowUnknownQuota": False, "health": "healthy", "quota": "available",
            "registeredSessions": [{"id": "session-a", "model": "opus", "workspace": "workspace-a"}],
        })
        registry.submit(assignment(), now=1)

    def install_snapshot(self, balance=1000):
        self.admission.ledger.set_snapshot(
            user_id="JQ", provider="lightsprint", account_id="account-a", unit="credits",
            cycle_id="2026-11", balance=balance, snapshot_date="2026-10-12",
            source="verified provider dashboard snapshot", verified=True,
        )

    def test_enabled_unknown_balance_never_releases_paid_mutation_to_worker(self):
        # The worker's only path to provider mutation is receiving a claimed DTO.
        # Unknown balance denies admission before the claim can expose that DTO.
        registry = create_job_registry(self.state)
        self.register_and_submit(registry)
        self.assertIsNone(registry.claim_operation("provider-worker", now=2))
        with registry.connection() as db:
            operation = db.execute("SELECT state,error_class FROM operations WHERE kind='chat_session'").fetchone()
        self.assertEqual((operation["state"], operation["error_class"]), ("rejected", "CreditAdmissionDenied"))
        snapshot = registry.get_assignment("assignment-a")
        self.assertEqual(snapshot["tasks"][0]["state"], "blocked")
        self.assertEqual(self.admission.ledger.available(
            user_id="JQ", provider="lightsprint", account_id="account-a", unit="credits"), None)

    def test_unmapped_account_is_denied_when_strict_mode_is_enabled(self):
        self.policy["accounts"] = {}
        self.write_config()
        registry = create_job_registry(self.state)
        self.register_and_submit(registry)
        self.assertIsNone(registry.claim_operation("provider-worker", now=2))
        with registry.connection() as db:
            row = db.execute("SELECT state FROM operations WHERE kind='chat_session'").fetchone()
        self.assertEqual(row["state"], "rejected")

    def test_insufficient_balance_denies_without_claiming_and_ledger_preserves_unit(self):
        self.install_snapshot(balance=99)
        self.assertIsNone(self.registry.claim_operation("provider-worker", now=2))
        with self.registry.connection() as db:
            row = db.execute("SELECT state FROM operations WHERE kind='chat_session'").fetchone()
        self.assertEqual(row["state"], "rejected")
        self.assertEqual(self.admission.ledger.available(
            user_id="JQ", provider="lightsprint", account_id="account-a", unit="credits"), 99)
        self.assertEqual(self.admission.ledger.account(
            user_id="JQ", provider="lightsprint", account_id="account-a", unit="credits")["snapshot_source"],
            "verified provider dashboard snapshot")

    def test_unverified_operation_max_denies_even_with_verified_balance(self):
        self.policy["accounts"]["account-a"]["costUpperBound"] = None
        self.policy["accounts"]["account-a"]["boundVerified"] = False
        self.write_config()
        self.admission = CreditAdmission.from_private_config(self.config, self.ledger_path)
        self.registry = JobRegistry(self.db_path, credit_admission=self.admission)
        self.install_snapshot()
        self.register_and_submit(self.registry)
        self.assertIsNone(self.registry.claim_operation("provider-worker", now=2))
        with self.registry.connection() as db:
            row = db.execute("SELECT state FROM operations WHERE kind='chat_session'").fetchone()
        self.assertEqual(row["state"], "rejected")
        self.assertEqual(self.admission.ledger.available(
            user_id="JQ", provider="lightsprint", account_id="account-a", unit="credits"), 1000)

    def test_unapproved_debit_source_cannot_settle_reservation(self):
        self.install_snapshot()
        operation = self.registry.claim_operation("provider-worker", now=2)
        with self.assertRaises(CreditDenied):
            self.admission.settle_verified_debit(operation_id=operation["operationId"], unit="credits",
                                                  amount=40, source="unapproved dashboard estimate", verified=True)
        with closing(self.admission.ledger._connect()) as db:
            row = db.execute("SELECT status FROM credit_operations WHERE operation_id=?",
                             (operation["operationId"],)).fetchone()
        self.assertEqual(row["status"], "active")

    def test_reservation_precedes_claim_and_only_verified_same_unit_debit_settles(self):
        self.install_snapshot()
        operation = self.registry.claim_operation("provider-worker", lease_seconds=30, now=2)
        self.assertEqual(operation["kind"], "chat_session")
        self.assertEqual(self.admission.ledger.available(
            user_id="JQ", provider="lightsprint", account_id="account-a", unit="credits"), 900)
        with self.assertRaises(CreditDenied):
            self.admission.settle_verified_debit(operation_id=operation["operationId"], unit="usd_cents",
                                                  amount=1, source="unrelated USD report", verified=True)
        result = self.registry.record_result(operation["operationId"], {
            "workerId": "provider-worker", "outcome": "accepted", "result": {
                "creditDebit": {"unit": "credits", "amount": 40,
                                "source": "provider debit receipt", "verified": True},
            },
        }, now=3)
        self.assertEqual(result["state"], "awaiting_output")
        self.assertEqual(self.admission.ledger.available(
            user_id="JQ", provider="lightsprint", account_id="account-a", unit="credits"), 960)

    def test_lease_expiry_and_restart_keep_ambiguous_reservation_held(self):
        self.install_snapshot()
        operation = self.registry.claim_operation("worker-one", lease_seconds=2, now=2)
        restarted_admission = CreditAdmission.from_private_config(self.config, self.ledger_path)
        restarted = JobRegistry(self.db_path, credit_admission=restarted_admission)
        self.assertIsNone(restarted.claim_operation("worker-two", now=5))
        with restarted.connection() as db:
            row = db.execute("SELECT state FROM operations WHERE id=?", (operation["operationId"],)).fetchone()
        self.assertEqual(row["state"], "ambiguous")
        self.assertEqual(restarted_admission.ledger.available(
            user_id="JQ", provider="lightsprint", account_id="account-a", unit="credits"), 900)
        with self.assertRaises(CreditDenied):
            restarted_admission.ledger.set_snapshot(
                user_id="JQ", provider="lightsprint", account_id="account-a", unit="credits",
                cycle_id="2026-12", balance=1000, snapshot_date="2026-11-01",
                source="next cycle", verified=True,
            )

    def test_accepted_without_authoritative_debit_keeps_upper_bound_held(self):
        self.install_snapshot()
        operation = self.registry.claim_operation("provider-worker", now=2)
        self.registry.record_result(operation["operationId"], {
            "workerId": "provider-worker", "outcome": "accepted",
        }, now=3)
        self.assertEqual(self.admission.ledger.available(
            user_id="JQ", provider="lightsprint", account_id="account-a", unit="credits"), 900)

    def test_documented_preexecution_refusal_releases_only_its_hold(self):
        self.install_snapshot()
        operation = self.registry.claim_operation("provider-worker", now=2)
        self.registry.record_result(operation["operationId"], {
            "workerId": "provider-worker", "outcome": "rejected", "errorClass": "session_not_sendable",
        }, now=3)
        self.assertEqual(self.admission.ledger.available(
            user_id="JQ", provider="lightsprint", account_id="account-a", unit="credits"), 1000)

    def test_missing_config_keeps_legacy_mode_explicit(self):
        config = self.state / "absent.json"
        self.assertFalse(config.exists())
        # The deployed bridge uses a missing policy file to stay in legacy mode;
        # a present but invalid strict file does not silently fall back.
        from snooze.bridge import create_job_registry
        legacy_state = self.root / "legacy"
        legacy_state.mkdir(mode=0o700)
        registry = create_job_registry(legacy_state)
        self.assertIsNone(registry.credit_admission)
        self.assertFalse((legacy_state / "credit-admission.json").exists())

    def test_invalid_config_permissions_fail_startup(self):
        self.config.chmod(0o644)
        with self.assertRaisesRegex(RuntimeError, "owner-only"):
            CreditAdmission.from_private_config(self.config, self.ledger_path)


if __name__ == "__main__":
    unittest.main()
