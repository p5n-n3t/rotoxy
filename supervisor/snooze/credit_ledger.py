"""Fail-closed numeric credit reservations for a single provider account.

This module is intentionally standalone. Runtime dispatch must not use it until
the caller can provide a verified positive upper bound in the provider's native
unit and a verified balance snapshot. It does not infer LightSprint prices.
"""

from __future__ import annotations

from contextlib import closing
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
import sqlite3
from typing import Optional


class CreditError(ValueError):
    """A request could not be safely admitted or reconciled."""


class CreditDenied(CreditError):
    """The operation lacks sufficient verified credit capacity."""


@dataclass(frozen=True)
class Reservation:
    operation_id: str
    user_id: str
    provider: str
    account_id: str
    unit: str
    cycle_id: str
    amount: int
    status: str
    idempotent_replay: bool = False


class CreditLedger:
    """SQLite ledger with serialized writers and exact integer accounting.

    ``unit`` is opaque (for example ``credits`` or ``usd_cents``); conversions
    are never performed. Snapshot provenance and date are mandatory.
    """

    def __init__(self, path: str | Path, *, timeout: float = 10.0):
        self.path = str(path)
        self.timeout = timeout
        Path(self.path).parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        with closing(self._connect()) as db:
            db.executescript(
                """
                CREATE TABLE IF NOT EXISTS credit_accounts (
                    user_id TEXT NOT NULL,
                    provider TEXT NOT NULL,
                    account_id TEXT NOT NULL,
                    unit TEXT NOT NULL,
                    cycle_id TEXT NOT NULL,
                    balance INTEGER NOT NULL CHECK(balance >= 0),
                    snapshot_date TEXT NOT NULL,
                    snapshot_recorded_at TEXT NOT NULL,
                    snapshot_source TEXT NOT NULL,
                    frozen_reason TEXT,
                    PRIMARY KEY(user_id, provider, account_id, unit)
                );
                CREATE TABLE IF NOT EXISTS credit_operations (
                    operation_id TEXT PRIMARY KEY,
                    user_id TEXT NOT NULL,
                    provider TEXT NOT NULL,
                    account_id TEXT NOT NULL,
                    unit TEXT NOT NULL,
                    cycle_id TEXT NOT NULL,
                    amount INTEGER NOT NULL CHECK(amount > 0),
                    bound_source TEXT NOT NULL,
                    status TEXT NOT NULL CHECK(status IN ('active','settled','refused')),
                    actual INTEGER CHECK(actual IS NULL OR actual >= 0),
                    violation INTEGER NOT NULL DEFAULT 0 CHECK(violation IN (0,1)),
                    created_at TEXT NOT NULL,
                    settled_at TEXT,
                    FOREIGN KEY(user_id, provider, account_id, unit)
                        REFERENCES credit_accounts(user_id, provider, account_id, unit)
                );
                CREATE INDEX IF NOT EXISTS credit_operations_account
                    ON credit_operations(user_id, provider, account_id, unit, status);
                """
            )
        Path(self.path).chmod(0o600)

    def _connect(self) -> sqlite3.Connection:
        db = sqlite3.connect(self.path, timeout=self.timeout, isolation_level=None)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA foreign_keys = ON")
        db.execute("PRAGMA busy_timeout = %d" % max(1, int(self.timeout * 1000)))
        return db

    @staticmethod
    def _text(value: str, label: str) -> str:
        if not isinstance(value, str) or not value.strip():
            raise CreditError(f"{label} must be a nonempty string")
        return value.strip()

    @staticmethod
    def _integer(value: int, label: str, *, positive: bool = False) -> int:
        if isinstance(value, bool) or not isinstance(value, int) or value < (1 if positive else 0):
            qualifier = "positive integer" if positive else "nonnegative integer"
            raise CreditError(f"{label} must be a {qualifier}")
        return value

    @staticmethod
    def _now() -> str:
        return datetime.now(timezone.utc).isoformat(timespec="microseconds")

    @staticmethod
    def _account_key(user_id: str, provider: str, account_id: str, unit: str) -> tuple[str, ...]:
        return user_id, provider, account_id, unit

    def set_snapshot(
        self, *, user_id: str, provider: str, account_id: str, unit: str,
        cycle_id: str, balance: int, snapshot_date: str, source: str,
        verified: bool, acknowledge_violation: bool = False,
    ) -> None:
        """Install an explicitly verified balance and billing-cycle snapshot.

        Date passage alone never renews a balance. Any active reservation blocks
        snapshot replacement, including a new cycle, so an in-flight debit cannot
        disappear during renewal. A verified new cycle clears depletion freezes;
        settlement violations require explicit acknowledgement to clear.
        """
        if verified is not True:
            raise CreditDenied("balance snapshot is not verified")
        user_id = self._text(user_id, "user_id")
        provider = self._text(provider, "provider")
        account_id = self._text(account_id, "account_id")
        unit = self._text(unit, "unit")
        cycle_id = self._text(cycle_id, "cycle_id")
        balance = self._integer(balance, "balance")
        snapshot_date = self._text(snapshot_date, "snapshot_date")
        source = self._text(source, "source")
        try:
            datetime.fromisoformat(snapshot_date.replace("Z", "+00:00"))
        except ValueError as exc:
            raise CreditError("snapshot_date must be an ISO-8601 date or timestamp") from exc
        with closing(self._connect()) as db:
            db.execute("BEGIN IMMEDIATE")
            active = db.execute(
                "SELECT 1 FROM credit_operations WHERE user_id=? AND provider=? AND account_id=? AND unit=? AND status='active' LIMIT 1",
                self._account_key(user_id, provider, account_id, unit),
            ).fetchone()
            if active:
                db.rollback()
                raise CreditDenied("cannot replace snapshot while reservations are active or ambiguous")
            old = db.execute(
                "SELECT cycle_id,frozen_reason FROM credit_accounts WHERE user_id=? AND provider=? AND account_id=? AND unit=?",
                self._account_key(user_id, provider, account_id, unit),
            ).fetchone()
            reason = old["frozen_reason"] if old else None
            new_cycle = old is None or old["cycle_id"] != cycle_id
            if new_cycle and reason == "depleted":
                reason = None
            if reason == "depleted" and balance > 0:
                reason = None
            if acknowledge_violation and source:
                reason = None
            db.execute(
                """INSERT INTO credit_accounts(user_id,provider,account_id,unit,cycle_id,balance,snapshot_date,snapshot_recorded_at,snapshot_source,frozen_reason)
                   VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(user_id,provider,account_id,unit) DO UPDATE SET
                   cycle_id=excluded.cycle_id,balance=excluded.balance,snapshot_date=excluded.snapshot_date,
                   snapshot_recorded_at=excluded.snapshot_recorded_at,
                   snapshot_source=excluded.snapshot_source,frozen_reason=excluded.frozen_reason""",
                (*self._account_key(user_id, provider, account_id, unit), cycle_id, balance, snapshot_date, self._now(), source, reason),
            )
            db.commit()

    def reserve(
        self, *, user_id: str, provider: str, account_id: str, unit: str,
        cycle_id: str, operation_id: str, cost_upper_bound: int,
        bound_verified: bool, bound_source: str,
    ) -> Reservation:
        """Atomically reserve a verified, positive, native-unit upper bound."""
        if bound_verified is not True:
            raise CreditDenied("task cost upper bound is not verified")
        user_id = self._text(user_id, "user_id")
        provider = self._text(provider, "provider")
        account_id = self._text(account_id, "account_id")
        unit = self._text(unit, "unit")
        cycle_id = self._text(cycle_id, "cycle_id")
        operation_id = self._text(operation_id, "operation_id")
        amount = self._integer(cost_upper_bound, "cost_upper_bound", positive=True)
        bound_source = self._text(bound_source, "bound_source")
        now = self._now()
        with closing(self._connect()) as db:
            db.execute("BEGIN IMMEDIATE")
            old = db.execute("SELECT * FROM credit_operations WHERE operation_id=?", (operation_id,)).fetchone()
            if old:
                same = (old["user_id"], old["provider"], old["account_id"], old["unit"], old["cycle_id"], old["amount"]) == (user_id, provider, account_id, unit, cycle_id, amount)
                if not same:
                    db.rollback()
                    raise CreditError("operation_id already belongs to a different reservation")
                db.commit()
                return self._reservation(old, replay=True)
            account = db.execute(
                "SELECT * FROM credit_accounts WHERE user_id=? AND provider=? AND account_id=? AND unit=?",
                self._account_key(user_id, provider, account_id, unit),
            ).fetchone()
            if not account:
                db.rollback()
                raise CreditDenied("no verified balance snapshot")
            if account["cycle_id"] != cycle_id:
                db.rollback()
                raise CreditDenied("requested billing cycle does not match verified snapshot")
            if account["frozen_reason"]:
                db.rollback()
                raise CreditDenied(f"account is frozen: {account['frozen_reason']}")
            totals = db.execute(
                """SELECT COALESCE(SUM(CASE WHEN status='active' AND created_at>=? THEN amount ELSE 0 END),0) AS reserved,
                          COALESCE(SUM(CASE WHEN status='settled' AND settled_at>=? THEN actual ELSE 0 END),0) AS settled
                   FROM credit_operations WHERE user_id=? AND provider=? AND account_id=? AND unit=? AND cycle_id=?""",
                (account["snapshot_recorded_at"], account["snapshot_recorded_at"], *self._account_key(user_id, provider, account_id, unit), cycle_id),
            ).fetchone()
            available = account["balance"] - totals["reserved"] - totals["settled"]
            if available <= 0:
                db.execute("UPDATE credit_accounts SET frozen_reason='depleted' WHERE user_id=? AND provider=? AND account_id=? AND unit=?", self._account_key(user_id, provider, account_id, unit))
                db.commit()
                raise CreditDenied("account is depleted")
            if amount > available:
                db.rollback()
                raise CreditDenied("verified balance does not cover reservation")
            db.execute(
                "INSERT INTO credit_operations(operation_id,user_id,provider,account_id,unit,cycle_id,amount,bound_source,status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
                (operation_id, user_id, provider, account_id, unit, cycle_id, amount, bound_source, "active", now),
            )
            if amount == available:
                db.execute("UPDATE credit_accounts SET frozen_reason='depleted' WHERE user_id=? AND provider=? AND account_id=? AND unit=?", self._account_key(user_id, provider, account_id, unit))
            db.commit()
        return Reservation(operation_id, user_id, provider, account_id, unit, cycle_id, amount, "active")

    @staticmethod
    def _reservation(row: sqlite3.Row, *, replay: bool = False) -> Reservation:
        return Reservation(row["operation_id"], row["user_id"], row["provider"], row["account_id"], row["unit"], row["cycle_id"], row["amount"], row["status"], replay)

    def mark_ambiguous(self, operation_id: str) -> Reservation:
        """Keep an uncertain operation reserved; this is a durable no-op marker."""
        operation_id = self._text(operation_id, "operation_id")
        with closing(self._connect()) as db:
            row = db.execute("SELECT * FROM credit_operations WHERE operation_id=?", (operation_id,)).fetchone()
        if not row:
            raise CreditError("unknown operation_id")
        return self._reservation(row)

    def release_refused(self, operation_id: str, *, known_preexecution_refusal: bool) -> bool:
        """Release only explicit proof that execution never began."""
        if known_preexecution_refusal is not True:
            raise CreditDenied("reservation release requires a known preexecution refusal")
        operation_id = self._text(operation_id, "operation_id")
        with closing(self._connect()) as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT status FROM credit_operations WHERE operation_id=?", (operation_id,)).fetchone()
            if not row:
                db.rollback()
                raise CreditError("unknown operation_id")
            if row["status"] == "refused":
                db.commit()
                return False
            if row["status"] != "active":
                db.rollback()
                raise CreditError("settled reservation cannot be released")
            db.execute("UPDATE credit_operations SET status='refused',settled_at=? WHERE operation_id=?", (self._now(), operation_id))
            op = db.execute("SELECT user_id,provider,account_id,unit,cycle_id FROM credit_operations WHERE operation_id=?", (operation_id,)).fetchone()
            acct_key = self._account_key(op["user_id"], op["provider"], op["account_id"], op["unit"])
            acct = db.execute("SELECT balance,snapshot_recorded_at FROM credit_accounts WHERE user_id=? AND provider=? AND account_id=? AND unit=?", acct_key).fetchone()
            totals = db.execute(
                """SELECT COALESCE(SUM(CASE WHEN status='active' AND created_at>=? THEN amount ELSE 0 END),0) AS held,
                          COALESCE(SUM(CASE WHEN status='settled' AND settled_at>=? THEN actual ELSE 0 END),0) AS spent
                   FROM credit_operations WHERE user_id=? AND provider=? AND account_id=? AND unit=? AND cycle_id=?""",
                (acct["snapshot_recorded_at"], acct["snapshot_recorded_at"], *acct_key, op["cycle_id"]),
            ).fetchone()
            if acct["balance"] - totals["held"] - totals["spent"] > 0:
                db.execute("UPDATE credit_accounts SET frozen_reason=NULL WHERE user_id=? AND provider=? AND account_id=? AND unit=? AND frozen_reason='depleted'", acct_key)
            db.commit()
            return True

    def settle(self, operation_id: str, *, actual_usage: int) -> Reservation:
        """Settle reported usage; over-bound usage freezes the account."""
        operation_id = self._text(operation_id, "operation_id")
        actual_usage = self._integer(actual_usage, "actual_usage")
        with closing(self._connect()) as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT * FROM credit_operations WHERE operation_id=?", (operation_id,)).fetchone()
            if not row:
                db.rollback()
                raise CreditError("unknown operation_id")
            if row["status"] == "settled":
                if row["actual"] != actual_usage:
                    db.rollback()
                    raise CreditError("operation already settled with different usage")
                db.commit()
                return self._reservation(row)
            if row["status"] != "active":
                db.rollback()
                raise CreditError("refused operation cannot be settled")
            violation = actual_usage > row["amount"]
            db.execute("UPDATE credit_operations SET status='settled',actual=?,violation=?,settled_at=? WHERE operation_id=?", (actual_usage, int(violation), self._now(), operation_id))
            account_key = self._account_key(row["user_id"], row["provider"], row["account_id"], row["unit"])
            if violation:
                reason = "settlement_violation"
            else:
                account = db.execute("SELECT balance,snapshot_recorded_at FROM credit_accounts WHERE user_id=? AND provider=? AND account_id=? AND unit=?", account_key).fetchone()
                totals = db.execute(
                    """SELECT COALESCE(SUM(CASE WHEN status='active' AND created_at>=? THEN amount ELSE 0 END),0) AS held,
                              COALESCE(SUM(CASE WHEN status='settled' AND settled_at>=? THEN actual ELSE 0 END),0) AS spent
                       FROM credit_operations WHERE user_id=? AND provider=? AND account_id=? AND unit=? AND cycle_id=?""",
                    (account["snapshot_recorded_at"], account["snapshot_recorded_at"], *account_key, row["cycle_id"]),
                ).fetchone()
                reason = "depleted" if account["balance"] - totals["held"] - totals["spent"] <= 0 else None
            if reason:
                db.execute("UPDATE credit_accounts SET frozen_reason=? WHERE user_id=? AND provider=? AND account_id=? AND unit=?", (reason, *account_key))
            else:
                db.execute("UPDATE credit_accounts SET frozen_reason=NULL WHERE user_id=? AND provider=? AND account_id=? AND unit=? AND frozen_reason='depleted'", account_key)
            db.commit()
        return Reservation(row["operation_id"], row["user_id"], row["provider"], row["account_id"], row["unit"], row["cycle_id"], row["amount"], "settled")

    def available(self, *, user_id: str, provider: str, account_id: str, unit: str) -> Optional[int]:
        """Return snapshot less live holds and settlements; None if unknown."""
        key = tuple(self._text(v, n) for v, n in zip((user_id, provider, account_id, unit), ("user_id", "provider", "account_id", "unit")))
        with closing(self._connect()) as db:
            account = db.execute("SELECT balance,cycle_id,snapshot_recorded_at FROM credit_accounts WHERE user_id=? AND provider=? AND account_id=? AND unit=?", key).fetchone()
            if not account:
                return None
            totals = db.execute(
                """SELECT COALESCE(SUM(CASE WHEN status='active' AND created_at>=? THEN amount ELSE 0 END),0) AS reserved,
                          COALESCE(SUM(CASE WHEN status='settled' AND settled_at>=? THEN actual ELSE 0 END),0) AS settled
                   FROM credit_operations WHERE user_id=? AND provider=? AND account_id=? AND unit=? AND cycle_id=?""",
                (account["snapshot_recorded_at"], account["snapshot_recorded_at"], *key, account["cycle_id"]),
            ).fetchone()
            return account["balance"] - totals["reserved"] - totals["settled"]

    def account(self, *, user_id: str, provider: str, account_id: str, unit: str) -> Optional[dict]:
        key = tuple(self._text(v, n) for v, n in zip((user_id, provider, account_id, unit), ("user_id", "provider", "account_id", "unit")))
        with closing(self._connect()) as db:
            row = db.execute("SELECT * FROM credit_accounts WHERE user_id=? AND provider=? AND account_id=? AND unit=?", key).fetchone()
        return dict(row) if row else None
