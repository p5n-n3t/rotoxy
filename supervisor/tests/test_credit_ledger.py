import tempfile
import threading
import unittest
from pathlib import Path

from snooze.credit_ledger import CreditDenied, CreditError, CreditLedger


class CreditLedgerTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.ledger = CreditLedger(Path(self.tmp.name) / "credits.sqlite")
        self.snapshot(balance=100)

    def snapshot(self, *, balance, cycle="cycle-1", verified=True):
        self.ledger.set_snapshot(
            user_id="user-1", provider="provider-x", account_id="account-1",
            unit="credits", cycle_id=cycle, balance=balance,
            snapshot_date="2026-10-11", source="verified provider balance",
            verified=verified,
        )

    def reserve(self, op, amount, *, cycle="cycle-1", unit="credits", verified=True):
        return self.ledger.reserve(
            user_id="user-1", provider="provider-x", account_id="account-1",
            unit=unit, cycle_id=cycle, operation_id=op, cost_upper_bound=amount,
            bound_verified=verified, bound_source="verified task upper bound",
        )

    def test_competing_writers_cannot_overreserve(self):
        barrier = threading.Barrier(2)
        outcomes = []

        def reserve(op):
            barrier.wait()
            try:
                self.reserve(op, 60)
                outcomes.append("reserved")
            except CreditDenied:
                outcomes.append("denied")

        threads = [threading.Thread(target=reserve, args=(op,)) for op in ("op-a", "op-b")]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        self.assertCountEqual(outcomes, ["reserved", "denied"])
        self.assertEqual(self.ledger.available(user_id="user-1", provider="provider-x", account_id="account-1", unit="credits"), 40)

    def test_idempotent_replay_does_not_double_reserve_and_mismatch_fails(self):
        first = self.reserve("same-op", 20)
        replay = self.reserve("same-op", 20)
        self.assertFalse(first.idempotent_replay)
        self.assertTrue(replay.idempotent_replay)
        self.assertEqual(self.ledger.available(user_id="user-1", provider="provider-x", account_id="account-1", unit="credits"), 80)
        with self.assertRaises(CreditError):
            self.reserve("same-op", 21)

    def test_unknown_snapshot_and_unverified_or_nonpositive_bound_fail_closed(self):
        with self.assertRaises(CreditDenied):
            self.ledger.reserve(
                user_id="u", provider="p", account_id="a", unit="credits", cycle_id="c",
                operation_id="unknown", cost_upper_bound=1, bound_verified=True, bound_source="x",
            )
        with self.assertRaises(CreditDenied):
            self.reserve("unverified", 1, verified=False)
        with self.assertRaises(CreditError):
            self.reserve("zero", 0)
        with self.assertRaises(CreditDenied):
            self.snapshot(balance=300, verified=False)

    def test_ambiguous_operation_holds_balance_and_blocks_snapshot_replacement(self):
        self.reserve("ambiguous", 30)
        self.ledger.mark_ambiguous("ambiguous")
        with self.assertRaises(CreditDenied):
            self.snapshot(balance=900, cycle="cycle-2")
        self.assertEqual(self.ledger.available(user_id="user-1", provider="provider-x", account_id="account-1", unit="credits"), 70)

    def test_release_requires_known_preexecution_refusal(self):
        self.reserve("refused", 25)
        with self.assertRaises(CreditDenied):
            self.ledger.release_refused("refused", known_preexecution_refusal=False)
        self.assertTrue(self.ledger.release_refused("refused", known_preexecution_refusal=True))
        self.assertEqual(self.ledger.available(user_id="user-1", provider="provider-x", account_id="account-1", unit="credits"), 100)

    def test_settlement_subtracts_actual_and_overage_freezes_account(self):
        self.reserve("normal", 30)
        self.ledger.settle("normal", actual_usage=12)
        self.assertEqual(self.ledger.available(user_id="user-1", provider="provider-x", account_id="account-1", unit="credits"), 88)
        self.reserve("over", 20)
        self.ledger.settle("over", actual_usage=21)
        self.assertEqual(self.ledger.account(user_id="user-1", provider="provider-x", account_id="account-1", unit="credits")["frozen_reason"], "settlement_violation")
        with self.assertRaises(CreditDenied):
            self.reserve("after-violation", 1)

    def test_depletion_freezes_and_only_verified_snapshot_renews(self):
        self.reserve("full", 100)
        self.assertEqual(self.ledger.account(user_id="user-1", provider="provider-x", account_id="account-1", unit="credits")["frozen_reason"], "depleted")
        with self.assertRaises(CreditDenied):
            self.snapshot(balance=100, cycle="cycle-2", verified=False)
        with self.assertRaises(CreditDenied):
            self.snapshot(balance=100, cycle="cycle-2")
        self.ledger.settle("full", actual_usage=100)
        self.snapshot(balance=50, cycle="cycle-2")
        self.assertEqual(self.ledger.available(user_id="user-1", provider="provider-x", account_id="account-1", unit="credits"), 50)

    def test_snapshot_rebases_prior_settlements_without_erasing_active_holds(self):
        self.reserve("settled-before-snapshot", 10)
        self.ledger.settle("settled-before-snapshot", actual_usage=10)
        self.snapshot(balance=75)
        self.assertEqual(self.ledger.available(user_id="user-1", provider="provider-x", account_id="account-1", unit="credits"), 75)
        self.reserve("still-active", 15)
        with self.assertRaises(CreditDenied):
            self.snapshot(balance=90, cycle="cycle-2")

    def test_units_are_isolated_and_never_converted(self):
        self.ledger.set_snapshot(
            user_id="user-1", provider="provider-x", account_id="account-1", unit="usd_cents",
            cycle_id="cycle-1", balance=500, snapshot_date="2026-10-11", source="provider report", verified=True,
        )
        self.reserve("usd-op", 250, unit="usd_cents")
        self.assertEqual(self.ledger.available(user_id="user-1", provider="provider-x", account_id="account-1", unit="usd_cents"), 250)
        self.assertEqual(self.ledger.available(user_id="user-1", provider="provider-x", account_id="account-1", unit="credits"), 100)


if __name__ == "__main__":
    unittest.main()
