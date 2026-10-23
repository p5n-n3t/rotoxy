"""Opt-in, fail-closed credit admission for paid provider mutations.

The config supplies trusted account identity and an optional verified maximum
in the provider's native billing unit. Unknown bounds are represented explicitly
and deny dispatch. Verified balance snapshots are installed separately in
CreditLedger and never refreshed as a side effect of startup.
"""
from __future__ import annotations

import argparse
from contextlib import closing
import json
import os
import re
import stat
from pathlib import Path

from .credit_ledger import CreditDenied, CreditLedger, Reservation


class CreditAdmission:
    def __init__(self, ledger: CreditLedger, accounts: dict, *, enabled: bool = True):
        if enabled is not True:
            raise ValueError("CreditAdmission is only constructed for strict mode")
        if not isinstance(accounts, dict):
            raise ValueError("Strict credit account policies must be an object")
        self.ledger = ledger
        self.accounts = self._validate_accounts(accounts)
        self.enabled = True

    @staticmethod
    def _text(value, label, maximum=256):
        if not isinstance(value, str) or not value.strip() or len(value) > maximum or "\x00" in value:
            raise ValueError(f"Invalid credit policy {label}")
        if re.search(r"(?i)bearer\s+\S+|lsat_[A-Za-z0-9_-]+", value):
            raise ValueError(f"Credential-like value in credit policy {label}")
        return value.strip()

    @classmethod
    def _validate_accounts(cls, accounts):
        clean = {}
        for account_id, policy in accounts.items():
            account_id = cls._text(account_id, "accountId")
            required = {"userId", "provider", "unit", "cycleId", "costUpperBound", "boundVerified", "boundSource", "verifiedDebitSources"}
            if not isinstance(policy, dict) or set(policy) != required:
                raise ValueError("Credit account policy has unsupported or missing fields")
            user_id = cls._text(policy["userId"], "userId")
            provider = cls._text(policy["provider"], "provider")
            unit = cls._text(policy["unit"], "unit")
            cycle_id = cls._text(policy["cycleId"], "cycleId")
            if type(policy["boundVerified"]) is not bool:
                raise ValueError("boundVerified must be boolean")
            amount = policy["costUpperBound"]
            if policy["boundVerified"]:
                if type(amount) is not int or amount <= 0:
                    raise ValueError("verified costUpperBound must be a positive native-unit integer")
            elif amount is not None:
                raise ValueError("unverified costUpperBound must be null")
            source = cls._text(policy["boundSource"], "boundSource", 512)
            debit_sources = policy["verifiedDebitSources"]
            if not isinstance(debit_sources, list) or len(debit_sources) > 16:
                raise ValueError("verifiedDebitSources must be a bounded list")
            debit_sources = [cls._text(item, "verified debit source", 512) for item in debit_sources]
            if len(set(debit_sources)) != len(debit_sources):
                raise ValueError("verifiedDebitSources must be distinct")
            clean[account_id] = {
                "user_id": user_id, "provider": provider, "unit": unit,
                "cycle_id": cycle_id, "cost_upper_bound": amount,
                "bound_verified": policy["boundVerified"], "bound_source": source,
                "verified_debit_sources": debit_sources,
            }
        return clean

    @classmethod
    def from_private_config(cls, config_path, ledger_path, *, allow_disabled=False):
        """Load a private, explicit strict-mode config; reject unsafe files."""
        path = Path(config_path)
        if path.is_symlink():
            raise RuntimeError("Refusing symlinked credit admission config")
        info = path.stat()
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
            raise RuntimeError("Credit admission config must be an owner-only regular file")
        if info.st_size > 128 * 1024:
            raise RuntimeError("Credit admission config is too large")
        body = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(body, dict) or set(body) != {"schemaVersion", "enabled", "accounts"}:
            raise ValueError("Credit admission config has unsupported or missing fields")
        # Older installations persist the explicit empty disabled state. Only
        # the bridge opts into this compatibility case; strict callers continue
        # to require enabled=True. Never reinterpret a malformed policy as off.
        if (allow_disabled and type(body["schemaVersion"]) is int and body["schemaVersion"] == 1
                and body["enabled"] is False and body["accounts"] == {}):
            return None
        if type(body["schemaVersion"]) is not int or body["schemaVersion"] != 1 or body["enabled"] is not True:
            raise ValueError("Credit admission config must explicitly enable schemaVersion 1 strict mode")
        ledger = CreditLedger(ledger_path)
        return cls(ledger, body["accounts"], enabled=body["enabled"])

    def reserve(self, *, operation_id: str, account_id: str) -> Reservation:
        """Reserve before a paid mutation is handed to an upstream worker."""
        policy = self.accounts.get(account_id)
        if policy is None:
            raise CreditDenied("no verified credit policy for selected account")
        if policy["bound_verified"] is not True:
            raise CreditDenied("operation cost upper bound is not verified")
        return self.ledger.reserve(
            user_id=policy["user_id"], provider=policy["provider"], account_id=account_id,
            unit=policy["unit"], cycle_id=policy["cycle_id"], operation_id=operation_id,
            cost_upper_bound=policy["cost_upper_bound"], bound_verified=True,
            bound_source=policy["bound_source"],
        )

    def settle_verified_debit(self, *, operation_id: str, unit: str, amount: int,
                              source: str, verified: bool) -> Reservation:
        """Settle only an explicitly verified provider debit in the reserved unit."""
        if verified is not True:
            raise CreditDenied("provider debit is not verified")
        source = self._text(source, "debit source", 512)
        unit = self._text(unit, "debit unit")
        if type(amount) is not int or amount < 0:
            raise CreditDenied("provider debit amount must be a nonnegative integer")
        with closing(self.ledger._connect()) as db:
            row = db.execute("SELECT unit FROM credit_operations WHERE operation_id=?", (operation_id,)).fetchone()
        if row is None:
            raise CreditDenied("no reservation exists for provider debit")
        if row["unit"] != unit:
            raise CreditDenied("provider debit unit does not match reservation")
        with closing(self.ledger._connect()) as db:
            row = db.execute("SELECT account_id FROM credit_operations WHERE operation_id=?", (operation_id,)).fetchone()
        policy = self.accounts.get(row["account_id"] if row else None)
        if policy is None or source not in policy["verified_debit_sources"]:
            raise CreditDenied("provider debit source is not approved for this account")
        # Persist evidence before settlement. If the process exits between these
        # writes, the active reservation remains and the same receipt can replay.
        with closing(self.ledger._connect()) as db:
            db.execute("""CREATE TABLE IF NOT EXISTS credit_debit_evidence (
                operation_id TEXT PRIMARY KEY, unit TEXT NOT NULL, amount INTEGER NOT NULL,
                source TEXT NOT NULL, recorded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)""")
            db.execute("BEGIN IMMEDIATE")
            existing = db.execute("SELECT unit,amount,source FROM credit_debit_evidence WHERE operation_id=?",
                                  (operation_id,)).fetchone()
            evidence = (unit, amount, source)
            if existing and tuple(existing) != evidence:
                db.rollback()
                raise CreditDenied("conflicting verified debit evidence")
            if not existing:
                db.execute("INSERT INTO credit_debit_evidence(operation_id,unit,amount,source) VALUES(?,?,?,?)",
                           (operation_id, unit, amount, source))
            db.commit()
        return self.ledger.settle(operation_id, actual_usage=amount)

    def release_known_refusal(self, operation_id: str, *, known_preexecution_refusal: bool):
        with closing(self.ledger._connect()) as db:
            if not db.execute("SELECT 1 FROM credit_operations WHERE operation_id=?", (operation_id,)).fetchone():
                return False
        return self.ledger.release_refused(
            operation_id, known_preexecution_refusal=known_preexecution_refusal,
        )

    def status(self):
        return {"mode": "strict", "accounts": [{
            "accountId": account_id, "provider": policy["provider"], "unit": policy["unit"],
            "cycleId": policy["cycle_id"], "operationUpperBound": policy["cost_upper_bound"],
            "boundVerified": policy["bound_verified"],
            "available": self.ledger.available(user_id=policy["user_id"], provider=policy["provider"],
                                                account_id=account_id, unit=policy["unit"]),
        } for account_id, policy in sorted(self.accounts.items())]}


def main(argv=None):
    """Small explicit operator interface; no snapshot is refreshed implicitly."""
    parser = argparse.ArgumentParser(description="Manage the local strict credit ledger")
    parser.add_argument("--config", required=True)
    parser.add_argument("--ledger", required=True)
    sub = parser.add_subparsers(dest="command", required=True)
    snapshot = sub.add_parser("snapshot", help="install a verified balance snapshot")
    snapshot.add_argument("--account", required=True)
    snapshot.add_argument("--balance", required=True, type=int)
    snapshot.add_argument("--snapshot-date", required=True)
    snapshot.add_argument("--source", required=True)
    snapshot.add_argument("--verified", action="store_true")
    settle = sub.add_parser("settle", help="reconcile an authoritative provider debit")
    settle.add_argument("--operation-id", required=True)
    settle.add_argument("--unit", required=True)
    settle.add_argument("--amount", required=True, type=int)
    settle.add_argument("--source", required=True)
    settle.add_argument("--verified", action="store_true")
    args = parser.parse_args(argv)
    admission = CreditAdmission.from_private_config(args.config, args.ledger)
    if args.command == "snapshot":
        policy = admission.accounts.get(args.account)
        if policy is None:
            raise SystemExit("No configured policy for account")
        admission.ledger.set_snapshot(
            user_id=policy["user_id"], provider=policy["provider"], account_id=args.account,
            unit=policy["unit"], cycle_id=policy["cycle_id"], balance=args.balance,
            snapshot_date=args.snapshot_date, source=args.source, verified=args.verified,
        )
        print("Verified snapshot installed")
    else:
        admission.settle_verified_debit(operation_id=args.operation_id, unit=args.unit,
                                        amount=args.amount, source=args.source, verified=args.verified)
        print("Verified debit reconciled")


if __name__ == "__main__":
    main()
