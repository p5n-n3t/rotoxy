#!/usr/bin/env python3
"""Read-only, exact-ID preview for historical LightSprint runtime records.

This tool deliberately has no destructive implementation yet. The retained
SQLite schemas do not consistently express provider ownership or foreign-key
cascades, so --apply is rejected until a journaled migration can preserve every
linked artifact and mixed-provider assignment.
"""
from __future__ import annotations

import argparse
import json
import os
import sqlite3
import stat
import sys
from pathlib import Path
from typing import Any


ACCOUNT_FIELDS = {"account_id", "accountId", "account", "selected_account", "selectedAccount"}
SESSION_FIELDS = {"session_id", "sessionId", "session", "remoteSession"}
PROVIDER_FIELDS = {"provider", "provider_id", "providerId"}
RECORD_ARRAYS = {"accounts", "snapshots", "usage", "reservations", "renewals", "scheduledRenewals", "sessionCosts"}


def private_regular_file(path: Path) -> os.stat_result:
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise ValueError("input must be a regular owner-private file (mode 0600 or stricter)")
    return info


def record_ids(value: dict[str, Any]) -> tuple[set[str], set[str], str | None]:
    accounts = {value[key] for key in ACCOUNT_FIELDS if isinstance(value.get(key), str)}
    sessions = {value[key] for key in SESSION_FIELDS if isinstance(value.get(key), str)}
    providers = {value[key].lower() for key in PROVIDER_FIELDS if isinstance(value.get(key), str)}
    provider = "lightsprint" if "lightsprint" in providers or "light-sprint" in providers else (next(iter(providers)) if len(providers) == 1 else None)
    return accounts, sessions, provider


def inspect_json(path: Path, account_ids: set[str], session_ids: set[str]) -> dict[str, Any]:
    private_regular_file(path)
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError("JSON store root must be an object")
    counts: dict[str, int] = {}
    blocked: list[str] = []

    def visit(value: Any, location: str, in_record_array: bool = False) -> None:
        if isinstance(value, dict):
            accounts, sessions, provider = record_ids(value)
            exact_match = bool(accounts & account_ids or sessions & session_ids)
            if exact_match:
                if provider == "lightsprint":
                    counts[location] = counts.get(location, 0) + 1
                else:
                    blocked.append(location)
            for key, child in value.items():
                if isinstance(child, list):
                    record_array = key in RECORD_ARRAYS
                    for index, item in enumerate(child):
                        visit(item, f"{location}.{key}[{index}]", record_array)
                elif isinstance(child, dict):
                    visit(child, f"{location}.{key}")
        elif isinstance(value, list):
            for index, item in enumerate(value):
                visit(item, f"{location}[{index}]", in_record_array)

    visit(data, "$" )
    return {"path": str(path), "kind": "json", "matches": counts, "blocked": sorted(set(blocked))}


def inspect_sqlite(path: Path, account_ids: set[str], session_ids: set[str]) -> dict[str, Any]:
    private_regular_file(path)
    uri = f"file:{path.resolve()}?mode=ro"
    connection = sqlite3.connect(uri, uri=True, timeout=2)
    connection.row_factory = sqlite3.Row
    matches: list[dict[str, Any]] = []
    blocked: list[str] = []
    try:
        tables = [row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")]
        for table in tables:
            quoted = '"' + table.replace('"', '""') + '"'
            table_info = list(connection.execute(f"PRAGMA table_info({quoted})"))
            columns = [row[1] for row in table_info]
            candidate_fields = set(columns) & (ACCOUNT_FIELDS | SESSION_FIELDS)
            json_columns = {key for key in ("data", "body", "input", "result", "text", "payload") if key in columns}
            if not candidate_fields and not json_columns:
                continue
            try:
                rows = connection.execute(f"SELECT rowid AS __retire_rowid__, * FROM {quoted}")
                row_label = lambda values: f"{table}[rowid={values['__retire_rowid__']}]"
            except sqlite3.OperationalError:
                primary_key = [row[1] for row in sorted((item for item in table_info if item[5]), key=lambda item: item[5])]
                if not primary_key:
                    blocked.append(f"{table}[no stable row identity]")
                    continue
                rows = connection.execute(f"SELECT * FROM {quoted}")
                row_label = lambda values, keys=primary_key: f"{table}[pk=" + ",".join(str(values[key]) for key in keys) + "]"
            for row in rows:
                values = dict(row)
                provider_values = {values[key].lower() for key in PROVIDER_FIELDS if key in values and isinstance(values[key], str)}
                row_accounts = {values[key] for key in ACCOUNT_FIELDS if key in values and isinstance(values[key], str)}
                row_sessions = {values[key] for key in SESSION_FIELDS if key in values and isinstance(values[key], str)}
                for key in json_columns:
                    raw = values.get(key)
                    if not isinstance(raw, str):
                        continue
                    try:
                        embedded = json.loads(raw)
                    except (ValueError, TypeError):
                        if any(identifier in raw for identifier in account_ids | session_ids):
                            blocked.append(row_label(values) + f"[unparsed:{key}]")
                        continue
                    stack = [embedded]
                    while stack:
                        item = stack.pop()
                        if isinstance(item, dict):
                            embedded_accounts, embedded_sessions, embedded_provider = record_ids(item)
                            if embedded_accounts & account_ids or embedded_sessions & session_ids:
                                row_accounts.update(embedded_accounts & account_ids)
                                row_sessions.update(embedded_sessions & session_ids)
                                if embedded_provider:
                                    provider_values.add(embedded_provider)
                            stack.extend(item.values())
                        elif isinstance(item, list):
                            stack.extend(item)
                account_hit = row_accounts & account_ids
                session_hit = row_sessions & session_ids
                if not account_hit and not session_hit:
                    continue
                # Explicit IDs are the scope supplied by the operator. A
                # conflicting provider field is retained and surfaced.
                if provider_values - {"lightsprint", "light-sprint"}:
                    blocked.append(row_label(values))
                    continue
                matches.append({"table": table, "row": row_label(values),
                                "accountIds": sorted(account_hit), "sessionIds": sorted(session_hit),
                                "providerColumn": "lightsprint" if provider_values else "operator-supplied exact IDs"})
    finally:
        connection.close()
    return {"path": str(path), "kind": "sqlite", "matches": matches, "blocked": blocked}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sqlite", action="append", default=[], metavar="PATH", help="owner-private SQLite store to inspect (repeatable)")
    parser.add_argument("--json-store", action="append", default=[], metavar="PATH", help="owner-private JSON store to inspect (repeatable)")
    parser.add_argument("--lightsprint-account-id", action="append", default=[], metavar="ID", help="exact retired account ID (repeatable)")
    parser.add_argument("--lightsprint-session-id", action="append", default=[], metavar="ID", help="exact retired session ID (repeatable)")
    parser.add_argument("--apply", action="store_true", help="unsupported: destructive apply awaits linked-record migration")
    parser.add_argument("--backup-dir", metavar="PATH", help="reserved for a future journaled apply")
    parser.add_argument("--json", action="store_true", help="machine-readable preview")
    args = parser.parse_args(argv)
    if args.apply:
        parser.error("--apply is currently unsupported: SQLite linked-record classification and a journaled restore path are not implemented")
    if not args.sqlite and not args.json_store:
        parser.error("provide at least one explicit --sqlite or --json-store path")
    account_ids = set(args.lightsprint_account_id)
    session_ids = set(args.lightsprint_session_id)
    if not account_ids and not session_ids:
        parser.error("provide exact --lightsprint-account-id and/or --lightsprint-session-id values")
    if any(not item or len(item) > 256 or any(ord(ch) < 32 for ch in item) for item in account_ids | session_ids):
        parser.error("IDs must be non-empty, control-free values of at most 256 characters")
    try:
        stores = [inspect_sqlite(Path(value), account_ids, session_ids) for value in args.sqlite]
        stores.extend(inspect_json(Path(value), account_ids, session_ids) for value in args.json_store)
    except (OSError, ValueError, sqlite3.Error, json.JSONDecodeError) as exc:
        print(f"retirement preview blocked: {exc}", file=sys.stderr)
        return 2
    result = {"mode": "read-only-preview", "applySupported": False,
              "scope": {"accountIds": sorted(account_ids), "sessionIds": sorted(session_ids)},
              "stores": stores,
              "notice": "No records were changed. Review linked records and mixed-provider assignments before any future migration."}
    if args.json:
        print(json.dumps(result, indent=2, sort_keys=True))
    else:
        print("LightSprint historical runtime retirement preview (read only)")
        print("Exact account IDs: " + (", ".join(sorted(account_ids)) or "none"))
        print("Exact session IDs: " + (", ".join(sorted(session_ids)) or "none"))
        for store in stores:
            print(f"\n{store['kind']}: {store['path']}")
            print(f"  candidate records: {sum(store['matches'].values()) if isinstance(store['matches'], dict) else len(store['matches'])}")
            print(f"  blocked/unclassified exact matches: {len(store['blocked'])}")
        print("\nPreview only. --apply is unsupported; no records were changed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
