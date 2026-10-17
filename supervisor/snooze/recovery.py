"""Durable, fail-closed incident supervision and bounded recovery actions.

External actions are injected from trusted setup code. Event data never selects
an executable, command, action adapter, or account/session binding.
"""
from __future__ import annotations

from contextlib import contextmanager
from decimal import Decimal, InvalidOperation
import hashlib
import json
import math
import os
from pathlib import Path
import re
import sqlite3
import time

from snooze.headless import _sanitize_advisory
from types import MappingProxyType

LEVELS = {"observe", "notify", "rules", "cloud-supervisor", "headless", "human"}
SIGNIFICANT = {"failed", "stalled", "ambiguous", "needs_instructions", "ownership_unknown", "quota_blocked"}
SUPERVISOR_EVENTS = SIGNIFICANT | {"idle", "completed", "cancelled", "timed_out", "needs_approval"}
IDENTITY = re.compile(r"[A-Za-z0-9_.:@/-]{1,160}\Z")
INCIDENTS = re.compile(r"[A-Za-z0-9_.-]{1,80}\Z")
MAX_EVENTS = 100_000
MAX_SESSIONS = 10_000
MAX_SCOPES = 1_000


class RecoveryError(ValueError):
    """Invalid or unsupported recovery request."""


def _id(value, name):
    if not isinstance(value, str) or not IDENTITY.fullmatch(value):
        raise RecoveryError("invalid_" + name)
    return value


def _usd_cents(value, name, *, zero=True):
    try:
        amount = Decimal(str(value))
    except (InvalidOperation, ValueError):
        raise RecoveryError("invalid_" + name) from None
    if not amount.is_finite() or amount < (0 if zero else Decimal("0.01")) or amount > Decimal("10000"):
        raise RecoveryError("invalid_" + name)
    cents = amount * 100
    if cents != cents.to_integral_value():
        raise RecoveryError("invalid_" + name)
    return int(cents)


def _json(value):
    return json.dumps(value, ensure_ascii=True, separators=(",", ":"), sort_keys=True)


class RecoveryEngine:
    """One-shot durable recovery engine; uncertain actions are never replayed.

    `adapters` maps trusted action names (or rule IDs) to callbacks accepting
    `(immutable_context, timeout_seconds)`. Callbacks return a mapping with
    state `accepted`, `rejected`, or `ambiguous`. Exceptions and malformed
    results are treated as ambiguous. Paid adapters require a separate trusted
    resource verifier and an explicit durable budget reservation.
    """

    def __init__(self, path, *, adapters=None, resource_verifier=None, oracle_pool=None, clock=time.time):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.chmod(self.path.parent, 0o700)
        self.adapters = dict(adapters or {})
        self.resource_verifier = resource_verifier
        self.oracle_pool = oracle_pool
        self.clock = clock
        old_umask = os.umask(0o077)
        try:
            with self.connection(write=True) as db:
                db.executescript("""
                CREATE TABLE IF NOT EXISTS recovery_policies(
                  scope TEXT PRIMARY KEY, revision INTEGER NOT NULL, body TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS recovery_sessions(
                  scope TEXT NOT NULL, project TEXT NOT NULL, job TEXT NOT NULL,
                  account TEXT NOT NULL, session TEXT NOT NULL, adapter TEXT NOT NULL,
                  PRIMARY KEY(scope,project,job,account,session));
                CREATE TABLE IF NOT EXISTS recovery_events(
                  event_id TEXT PRIMARY KEY, scope TEXT NOT NULL, project TEXT NOT NULL,
                  job TEXT NOT NULL, kind TEXT NOT NULL, severity TEXT NOT NULL,
                  account TEXT NOT NULL, session TEXT NOT NULL, created REAL NOT NULL,
                  state TEXT NOT NULL, decision TEXT, updated REAL NOT NULL);
                CREATE INDEX IF NOT EXISTS recovery_event_scope ON recovery_events(scope,created);
                CREATE TABLE IF NOT EXISTS recovery_actions(
                  event_id TEXT NOT NULL, action TEXT NOT NULL, attempt INTEGER NOT NULL,
                  state TEXT NOT NULL, started REAL NOT NULL, finished REAL,
                  receipt TEXT, error_code TEXT, reserved_cents INTEGER NOT NULL DEFAULT 0,
                  definitely_not_started INTEGER NOT NULL DEFAULT 0,
                  PRIMARY KEY(event_id,action,attempt));
                CREATE TABLE IF NOT EXISTS recovery_budget(
                  scope TEXT PRIMARY KEY, reserved_cents INTEGER NOT NULL DEFAULT 0,
                  spent_cents INTEGER NOT NULL DEFAULT 0);
                CREATE TABLE IF NOT EXISTS recovery_advice(
                  event_id TEXT PRIMARY KEY, scope TEXT NOT NULL, job_id TEXT NOT NULL UNIQUE, state TEXT NOT NULL,
                  created REAL NOT NULL, error_code TEXT);
                """)
            os.chmod(self.path, 0o600)
        finally:
            os.umask(old_umask)
        self.reconcile_inflight()

    @contextmanager
    def connection(self, write=False):
        db = sqlite3.connect(self.path, timeout=10)
        db.row_factory = sqlite3.Row
        try:
            if write:
                db.execute("BEGIN IMMEDIATE")
            yield db
            if write:
                db.commit()
        except BaseException:
            if write:
                db.rollback()
            raise
        finally:
            db.close()

    @staticmethod
    def _policy(raw):
        required = {"level", "permissions", "rules", "max_attempts", "max_runtime_seconds",
                    "action_budget_usd", "budget_ceiling_usd", "oracle_advice",
                    "oracle_hourly_limit", "headless_adapter_verified"}
        if not isinstance(raw, dict) or set(raw) != required:
            raise RecoveryError("policy_fields_invalid")
        if raw["level"] not in LEVELS:
            raise RecoveryError("policy_level_invalid")
        permissions = raw["permissions"]
        if not isinstance(permissions, list) or len(set(permissions)) != len(permissions):
            raise RecoveryError("policy_permissions_invalid")
        if any(not isinstance(p, str) or not (p in {"notify", "cloud-supervisor", "headless"} or
                   p.startswith("rule:") and INCIDENTS.fullmatch(p[5:])) for p in permissions):
            raise RecoveryError("policy_permissions_invalid")
        rules = raw["rules"]
        if not isinstance(rules, dict) or len(rules) > 32 or any(
                not isinstance(k, str) or not INCIDENTS.fullmatch(k) or
                not isinstance(v, str) or not INCIDENTS.fullmatch(v) for k, v in rules.items()):
            raise RecoveryError("policy_rules_invalid")
        if type(raw["max_attempts"]) is not int or not 1 <= raw["max_attempts"] <= 5:
            raise RecoveryError("policy_attempt_limit_invalid")
        if type(raw["max_runtime_seconds"]) is not int or not 1 <= raw["max_runtime_seconds"] <= 300:
            raise RecoveryError("policy_runtime_limit_invalid")
        budget = _usd_cents(raw["action_budget_usd"], "action_budget")
        ceiling = _usd_cents(raw["budget_ceiling_usd"], "budget_ceiling")
        if budget > ceiling:
            raise RecoveryError("policy_budget_exceeds_ceiling")
        if raw["level"] in {"cloud-supervisor", "headless"} and (budget < 1 or ceiling < 1):
            raise RecoveryError("paid_action_needs_explicit_budget")
        if type(raw["oracle_advice"]) is not bool or type(raw["headless_adapter_verified"]) is not bool:
            raise RecoveryError("policy_flag_invalid")
        if type(raw["oracle_hourly_limit"]) is not int or not 0 <= raw["oracle_hourly_limit"] <= 10:
            raise RecoveryError("policy_oracle_limit_invalid")
        return {**raw, "permissions": sorted(permissions), "rules": dict(rules),
                "action_budget_cents": budget, "budget_ceiling_cents": ceiling}

    def configure(self, scope, policy):
        scope = _id(scope, "scope")
        normalized = self._policy(policy)
        stored_policy = {key: normalized[key] for key in (
            "level", "permissions", "rules", "max_attempts", "max_runtime_seconds",
            "action_budget_usd", "budget_ceiling_usd", "oracle_advice",
            "oracle_hourly_limit", "headless_adapter_verified")}
        with self.connection(write=True) as db:
            previous = db.execute("SELECT revision FROM recovery_policies WHERE scope=?", (scope,)).fetchone()
            if previous is None and db.execute("SELECT COUNT(*) FROM recovery_policies").fetchone()[0] >= MAX_SCOPES:
                raise RecoveryError("policy_capacity_full")
            revision = (previous["revision"] if previous else 0) + 1
            db.execute("INSERT INTO recovery_policies VALUES(?,?,?) ON CONFLICT(scope) DO UPDATE SET revision=excluded.revision,body=excluded.body",
                       (scope, revision, _json(stored_policy)))
            db.execute("INSERT OR IGNORE INTO recovery_budget(scope) VALUES(?)", (scope,))
        return {"scope": scope, "revision": revision, "level": normalized["level"]}

    def register_session(self, *, scope, project, job, account, session, adapter):
        """Bind a target from trusted setup; events cannot choose or change it."""
        values = tuple(_id(v, n) for v, n in ((scope, "scope"), (project, "project"),
                       (job, "job"), (account, "account"), (session, "session"), (adapter, "adapter")))
        with self.connection(write=True) as db:
            prior = db.execute("SELECT adapter FROM recovery_sessions WHERE scope=? AND project=? AND job=? AND account=? AND session=?", values[:5]).fetchone()
            if prior and prior["adapter"] != adapter:
                raise RecoveryError("session_binding_conflict")
            if prior is None and db.execute("SELECT COUNT(*) FROM recovery_sessions").fetchone()[0] >= MAX_SESSIONS:
                raise RecoveryError("session_capacity_full")
            db.execute("INSERT OR IGNORE INTO recovery_sessions VALUES(?,?,?,?,?,?)", values)
        return {"registered": True, "sessionId": session, "accountId": account}

    def ingest(self, event):
        required = {"event_id", "scope", "project", "job", "kind", "severity", "account", "session"}
        if not isinstance(event, dict) or set(event) != required:
            raise RecoveryError("event_fields_invalid")
        vals = [_id(event[k], k) for k in ("event_id", "scope", "project", "job", "account", "session")]
        kind, severity = event["kind"], event["severity"]
        if not isinstance(kind, str) or not INCIDENTS.fullmatch(kind) or not isinstance(severity, str) or not INCIDENTS.fullmatch(severity):
            raise RecoveryError("event_classification_invalid")
        now = self.clock()
        with self.connection(write=True) as db:
            prior = db.execute("SELECT 1 FROM recovery_events WHERE event_id=?", (vals[0],)).fetchone()
            if prior is None and db.execute("SELECT COUNT(*) FROM recovery_events").fetchone()[0] >= MAX_EVENTS:
                raise RecoveryError("event_capacity_full")
            db.execute("INSERT OR IGNORE INTO recovery_events(event_id,scope,project,job,kind,severity,account,session,created,state,updated) VALUES(?,?,?,?,?,?,?,?,?,'received',?)",
                       (vals[0], vals[1], vals[2], vals[3], kind, severity, vals[4], vals[5], now, now))
            row = db.execute("SELECT * FROM recovery_events WHERE event_id=?", (vals[0],)).fetchone()
            if tuple(row[k] for k in ("scope", "project", "job", "kind", "severity", "account", "session")) != (vals[1], vals[2], vals[3], kind, severity, vals[4], vals[5]):
                raise RecoveryError("event_id_conflict")
            return self._event_receipt(row, deduplicated=bool(prior))

    @staticmethod
    def _event_receipt(row, **extra):
        return {"eventId": row["event_id"], "state": row["state"], "decision": json.loads(row["decision"]) if row["decision"] else None, **extra}

    def get(self, event_id):
        event_id = _id(event_id, "event_id")
        with self.connection() as db:
            row = db.execute("SELECT * FROM recovery_events WHERE event_id=?", (event_id,)).fetchone()
            if not row:
                raise KeyError("event_not_found")
            action = db.execute("SELECT action,attempt,state,started,finished,receipt,error_code,reserved_cents FROM recovery_actions WHERE event_id=? ORDER BY attempt DESC LIMIT 1", (event_id,)).fetchone()
            advice = db.execute("SELECT job_id,state,error_code FROM recovery_advice WHERE event_id=?", (event_id,)).fetchone()
        return {**self._event_receipt(row), "action": dict(action) if action else None,
                "advice": dict(advice) if advice else None}

    def reconcile_inflight(self):
        """Fence expired claims as ambiguous; never requeue an external action."""
        now = self.clock()
        changed = 0
        with self.connection(write=True) as db:
            rows = db.execute("SELECT e.event_id,e.updated,p.body FROM recovery_events e JOIN recovery_policies p ON p.scope=e.scope WHERE e.state='claimed'").fetchall()
            for row in rows:
                policy = self._policy(json.loads(row["body"]))
                if now - row["updated"] <= policy["max_runtime_seconds"] + 5:
                    continue
                decision = {"outcome": "ambiguous", "reason": "owner_timeout_ambiguous"}
                db.execute("UPDATE recovery_actions SET state='ambiguous',finished=?,error_code='owner_timeout_ambiguous' WHERE event_id=? AND state='claimed'",
                           (now, row["event_id"]))
                changed += db.execute("UPDATE recovery_events SET state='ambiguous',decision=?,updated=? WHERE event_id=? AND state='claimed'",
                                      (_json(decision), now, row["event_id"])).rowcount
        return changed

    def _resources(self, row, policy):
        if self.resource_verifier is None:
            return None, "resource_verifier_unavailable"
        try:
            result = self.resource_verifier({"project": row["project"], "job": row["job"], "account": row["account"], "session": row["session"]})
        except Exception:
            return None, "resource_verification_failed"
        observed = result.get("observedAt") if isinstance(result, dict) else None
        fresh = type(observed) in {int, float} and math.isfinite(observed) and -5 <= self.clock() - observed <= 30
        if not isinstance(result, dict) or result.get("verified") is not True or result.get("quota") != "available" or result.get("budgetVerified") is not True or not fresh or result.get("project") != row["project"] or result.get("job") != row["job"] or result.get("account") != row["account"] or result.get("session") != row["session"]:
            return None, "quota_or_budget_unverified"
        try:
            available = _usd_cents(result.get("availableBudgetUsd"), "available_budget")
        except RecoveryError:
            return None, "quota_or_budget_unverified"
        if available < policy["action_budget_cents"]:
            return None, "verified_budget_insufficient"
        return {"verified": True, "available_budget_cents": available}, None

    def _handoff(self, event_id, reason, level):
        decision = {"level": level, "outcome": "human_handoff", "reason": reason}
        with self.connection(write=True) as db:
            db.execute("UPDATE recovery_events SET state='handoff',decision=?,updated=? WHERE event_id=? AND state IN ('received','retryable')",
                       (_json(decision), self.clock(), event_id))
            row = db.execute("SELECT * FROM recovery_events WHERE event_id=?", (event_id,)).fetchone()
        return self._event_receipt(row)

    def run(self, event_id):
        """Plan and run one authorized step; repeated calls never replay uncertainty."""
        event_id = _id(event_id, "event_id")
        self.reconcile_inflight()
        now = self.clock()
        with self.connection(write=True) as db:
            row = db.execute("SELECT * FROM recovery_events WHERE event_id=?", (event_id,)).fetchone()
            if not row:
                raise KeyError("event_not_found")
            policy_row = db.execute("SELECT revision,body FROM recovery_policies WHERE scope=?", (row["scope"],)).fetchone()
            if not policy_row:
                decision = {"level": "human", "outcome": "human_handoff", "reason": "policy_missing"}
                db.execute("UPDATE recovery_events SET state='handoff',decision=?,updated=? WHERE event_id=? AND state='received'", (_json(decision), now, event_id))
                row = db.execute("SELECT * FROM recovery_events WHERE event_id=?", (event_id,)).fetchone()
                receipt = self._event_receipt(row)
                policy = None
            else:
                policy = self._policy(json.loads(policy_row["body"]))
                if row["state"] in {"claimed", "ambiguous"}:
                    # A claimed action may have crossed its external boundary.
                    # It stays held forever unless a human reconciles it.
                    row = db.execute("SELECT * FROM recovery_events WHERE event_id=?", (event_id,)).fetchone()
                    receipt = self._event_receipt(row, deduplicated=True)
                elif row["state"] not in {"received", "retryable"}:
                    receipt = self._event_receipt(row, deduplicated=True)
                else:
                    receipt = None
        if policy is None or receipt is not None:
            if policy and self._policy(json.loads(policy_row["body"]))["oracle_advice"]:
                self.request_advice(event_id)
            return receipt

        level = policy["level"]
        if level in {"observe", "human"}:
            outcome = "observed" if level == "observe" else "human_handoff"
            state = "observed" if level == "observe" else "handoff"
            decision = {"level": level, "outcome": outcome, "reason": None}
            with self.connection(write=True) as db:
                db.execute("UPDATE recovery_events SET state=?,decision=?,updated=? WHERE event_id=? AND state IN ('received','retryable')",
                           (state, _json(decision), self.clock(), event_id))
                row = db.execute("SELECT * FROM recovery_events WHERE event_id=?", (event_id,)).fetchone()
            result = self._event_receipt(row)
            if policy["oracle_advice"] and row["kind"] in SIGNIFICANT:
                result["advice"] = self.request_advice(event_id)
            return result

        required_permission, action = level, level
        if level == "rules":
            action = policy["rules"].get(row["kind"])
            required_permission = "rule:" + action if action else ""
        if not required_permission or required_permission not in policy["permissions"]:
            result = self._handoff(event_id, "action_not_permitted", level)
        elif level == "headless" and not policy["headless_adapter_verified"]:
            result = self._handoff(event_id, "headless_adapter_unverified", level)
        elif level == "cloud-supervisor" and row["kind"] not in SIGNIFICANT:
            result = self._handoff(event_id, "incident_not_significant", level)
        elif level == "headless" and row["kind"] not in SUPERVISOR_EVENTS:
            result = self._handoff(event_id, "incident_not_significant", level)
        elif level == "rules" and (not action or action not in self.adapters):
            result = self._handoff(event_id, "registered_rule_unavailable", level)
        elif action not in self.adapters:
            result = self._handoff(event_id, "registered_adapter_unavailable", level)
        else:
            with self.connection() as db:
                binding = db.execute("SELECT adapter FROM recovery_sessions WHERE scope=? AND project=? AND job=? AND account=? AND session=?",
                                     (row["scope"], row["project"], row["job"], row["account"], row["session"])).fetchone()
            if binding is None:
                result = self._handoff(event_id, "registered_session_binding_missing", level)
            elif level == "headless" and binding["adapter"] not in {"codex", "claude"}:
                result = self._handoff(event_id, "headless_adapter_unsupported", level)
            else:
                resources = None
                if level in {"cloud-supervisor", "headless"}:
                    resources, reason = self._resources(row, policy)
                    if reason:
                        result = self._handoff(event_id, reason, level)
                    else:
                        result = self._execute(event_id, row, policy_row["revision"], policy, action, resources, binding["adapter"])
                else:
                    result = self._execute(event_id, row, policy_row["revision"], policy, action, None, binding["adapter"])
        if policy["oracle_advice"] and row["kind"] in SIGNIFICANT:
            result["advice"] = self.request_advice(event_id)
        return result

    def _execute(self, event_id, event, policy_revision, policy, action, resources, session_adapter):
        if action not in self.adapters:
            return self._handoff(event_id, "registered_adapter_unavailable", policy["level"])
        now = self.clock()
        reserve = policy["action_budget_cents"] if policy["level"] in {"cloud-supervisor", "headless"} else 0
        with self.connection(write=True) as db:
            current = db.execute("SELECT state,scope FROM recovery_events WHERE event_id=?", (event_id,)).fetchone()
            current_policy = db.execute("SELECT revision FROM recovery_policies WHERE scope=?", (current["scope"],)).fetchone()
            if current["state"] not in {"received", "retryable"} or not current_policy or current_policy["revision"] != policy_revision:
                return self._event_receipt(db.execute("SELECT * FROM recovery_events WHERE event_id=?", (event_id,)).fetchone(), deduplicated=True)
            previous = db.execute("SELECT MAX(attempt) AS attempt FROM recovery_actions WHERE event_id=? AND action=?", (event_id, action)).fetchone()["attempt"] or 0
            if previous >= policy["max_attempts"]:
                # Return to transaction-free handoff after releasing this lock.
                no_attempts = True
            else:
                no_attempts = False
            if no_attempts:
                db.execute("UPDATE recovery_events SET state='handoff',decision=?,updated=? WHERE event_id=?",
                           (_json({"level": policy["level"], "outcome": "human_handoff", "reason": "attempt_limit_reached"}), now, event_id))
                return self._event_receipt(db.execute("SELECT * FROM recovery_events WHERE event_id=?", (event_id,)).fetchone())
            if reserve:
                budget = db.execute("SELECT reserved_cents,spent_cents FROM recovery_budget WHERE scope=?", (current["scope"],)).fetchone()
                if budget["spent_cents"] + budget["reserved_cents"] + reserve > policy["budget_ceiling_cents"]:
                    db.execute("UPDATE recovery_events SET state='handoff',decision=?,updated=? WHERE event_id=?",
                               (_json({"level": policy["level"], "outcome": "human_handoff", "reason": "budget_ceiling_reached"}), now, event_id))
                    return self._event_receipt(db.execute("SELECT * FROM recovery_events WHERE event_id=?", (event_id,)).fetchone())
                db.execute("UPDATE recovery_budget SET reserved_cents=reserved_cents+? WHERE scope=?", (reserve, current["scope"]))
            attempt = previous + 1
            db.execute("INSERT INTO recovery_actions(event_id,action,attempt,state,started,reserved_cents) VALUES(?,?,?,'claimed',?,?)",
                       (event_id, action, attempt, now, reserve))
            db.execute("UPDATE recovery_events SET state='claimed',decision=?,updated=? WHERE event_id=?",
                       (_json({"level": policy["level"], "action": action, "attempt": attempt, "policy_revision": policy_revision}), now, event_id))
        context = MappingProxyType({"event_id": event_id, "scope": event["scope"], "project": event["project"],
            "job": event["job"], "kind": event["kind"], "severity": event["severity"],
            "account": event["account"], "session": event["session"], "attempt": attempt,
            "session_adapter": session_adapter, "max_attempts": policy["max_attempts"], "resources": resources})
        started = self.clock()
        try:
            response = self.adapters[action](context, policy["max_runtime_seconds"])
            if not isinstance(response, dict) or response.get("state") not in {"accepted", "rejected", "ambiguous"}:
                raise RecoveryError("adapter_receipt_invalid")
            state = response["state"]
            safe_not_started = state == "rejected" and response.get("definitely_not_started") is True
            if state == "rejected" and not safe_not_started:
                state = "ambiguous"
            if self.clock() - started > policy["max_runtime_seconds"]:
                state, safe_not_started = "ambiguous", False
            receipt = self._safe_receipt(response.get("receipt", {}))
        except Exception as exc:
            state, safe_not_started = "ambiguous", False
            receipt = {"errorClass": type(exc).__name__[:80]}
        finished = self.clock()
        with self.connection(write=True) as db:
            action_row = db.execute("SELECT * FROM recovery_actions WHERE event_id=? AND action=? AND attempt=?", (event_id, action, attempt)).fetchone()
            if action_row["state"] != "claimed":
                return self._event_receipt(db.execute("SELECT * FROM recovery_events WHERE event_id=?", (event_id,)).fetchone())
            if reserve and safe_not_started:
                db.execute("UPDATE recovery_budget SET reserved_cents=MAX(0,reserved_cents-?) WHERE scope=?", (reserve, event["scope"]))
            elif reserve and state == "accepted":
                db.execute("UPDATE recovery_budget SET reserved_cents=MAX(0,reserved_cents-?),spent_cents=spent_cents+? WHERE scope=?",
                           (reserve, reserve, event["scope"]))
            action_state = "ambiguous" if state == "ambiguous" else "rejected" if state == "rejected" else "completed"
            db.execute("UPDATE recovery_actions SET state=?,finished=?,receipt=?,error_code=?,definitely_not_started=? WHERE event_id=? AND action=? AND attempt=?",
                       (action_state, finished, _json(receipt), None if state == "accepted" else "adapter_" + state,
                        int(safe_not_started), event_id, action, attempt))
            next_state = "ambiguous" if action_state == "ambiguous" else "retryable" if safe_not_started and attempt < policy["max_attempts"] else "handoff" if action_state == "rejected" else "completed"
            decision = {"level": policy["level"], "action": action, "attempt": attempt,
                        "outcome": next_state, "error": None if state == "accepted" else "adapter_" + state,
                        "budgetReservedCents": reserve, "budgetHeld": bool(reserve and state == "ambiguous")}
            db.execute("UPDATE recovery_events SET state=?,decision=?,updated=? WHERE event_id=? AND state='claimed'",
                       (next_state, _json(decision), finished, event_id))
            row = db.execute("SELECT * FROM recovery_events WHERE event_id=?", (event_id,)).fetchone()
        return self._event_receipt(row)

    @staticmethod
    def _safe_receipt(raw):
        if not isinstance(raw, dict):
            return {}
        safe = {}
        for key in ("adapter", "request_id", "code", "state"):
            value = raw.get(key)
            if isinstance(value, str) and len(value) <= 160 and re.fullmatch(r"[A-Za-z0-9_.:@/-]*", value):
                safe[key] = value
        for key in ("exit_code", "elapsed_ms", "bytes"):
            value = raw.get(key)
            if type(value) is int and -255 <= value <= 2**31:
                safe[key] = value
        # A Codex resume may return one bounded advisory.  Re-sanitize here so
        # a future adapter cannot persist raw model output through this receipt
        # boundary.  Other adapters remain metadata-only.
        if raw.get("adapter") == "codex-exec-resume":
            advisory, truncated = _sanitize_advisory(raw.get("advisory"))
            if advisory is not None:
                safe["advisory"] = advisory
                safe["advisoryOnly"] = True
                safe["advisoryTruncated"] = bool(raw.get("advisoryTruncated") is True or truncated)
        return safe

    def request_advice(self, event_id):
        """Queue local Oracle advice only for significant incidents; never execute it."""
        event_id = _id(event_id, "event_id")
        if self.oracle_pool is None:
            return {"state": "unavailable", "reason": "oracle_pool_unavailable"}
        now = self.clock()
        with self.connection(write=True) as db:
            event = db.execute("SELECT * FROM recovery_events WHERE event_id=?", (event_id,)).fetchone()
            if not event:
                raise KeyError("event_not_found")
            policy_row = db.execute("SELECT body FROM recovery_policies WHERE scope=?", (event["scope"],)).fetchone()
            policy = self._policy(json.loads(policy_row["body"])) if policy_row else None
            if event["kind"] not in SIGNIFICANT:
                return {"state": "skipped", "reason": "incident_not_significant"}
            if not policy or not policy["oracle_advice"] or policy["oracle_hourly_limit"] == 0:
                return {"state": "skipped", "reason": "oracle_advice_not_permitted"}
            prior = db.execute("SELECT job_id,state,error_code FROM recovery_advice WHERE event_id=?", (event_id,)).fetchone()
            if prior:
                return dict(prior)
            recent = db.execute("SELECT COUNT(*) FROM recovery_advice WHERE scope=? AND created>?",
                                (event["scope"], now - 3600)).fetchone()[0]
            if recent >= policy["oracle_hourly_limit"]:
                return {"state": "skipped", "reason": "oracle_hourly_limit"}
            job_id = "recovery-" + hashlib.sha256(event_id.encode()).hexdigest()[:24]
            db.execute("INSERT INTO recovery_advice VALUES(?,?,?, 'claimed', ?, NULL)", (event_id, event["scope"], job_id, now))
        # OraclePool.submit is a durable queue write with a stable idempotency key.
        # Prompt contains classification and affinity only; model output is advisory.
        prompt = ("Review this significant worker incident and return at most five concise diagnostic suggestions. "
                  "Do not execute actions, emit shell commands, recommend blind retries, or treat an idle session as success. "
                  "Use human handoff when evidence or verified budget is missing. "
                  + _json({"event": event_id, "kind": event["kind"], "severity": event["severity"],
                           "project": event["project"], "job": event["job"], "account": event["account"], "session": event["session"]}))
        try:
            self.oracle_pool.submit(prompt, model="qwen3.5:9b", job_id=job_id, source="recovery:" + hashlib.sha256(event_id.encode()).hexdigest()[:20])
            state, error = "queued", None
        except Exception as exc:
            state, error = "ambiguous", type(exc).__name__[:80]
        with self.connection(write=True) as db:
            db.execute("UPDATE recovery_advice SET state=?,error_code=? WHERE event_id=? AND state='claimed'", (state, error, event_id))
        return {"job_id": job_id, "state": state, "error_code": error}

    def pending_handoffs(self, *, scope=None, limit=100):
        if type(limit) is not int or not 1 <= limit <= 100:
            raise RecoveryError("invalid_page")
        with self.connection() as db:
            if scope is None:
                rows = db.execute("SELECT event_id,scope,project,job,kind,created,decision FROM recovery_events WHERE state='handoff' ORDER BY created LIMIT ?", (limit,)).fetchall()
            else:
                rows = db.execute("SELECT event_id,scope,project,job,kind,created,decision FROM recovery_events WHERE state='handoff' AND scope=? ORDER BY created LIMIT ?", (_id(scope, "scope"), limit)).fetchall()
        return [{**dict(row), "decision": json.loads(row["decision"]) if row["decision"] else None} for row in rows]
