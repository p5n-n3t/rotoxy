#!/usr/bin/env python3
"""Exercise real supervisor processes with synthetic incidents and isolated state.

No credentials, inference, provider calls or production databases are used. This
checks durable local recovery; it is not a cloud-task execution test.
"""
import argparse
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import time


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    root = args.root.resolve()
    with tempfile.TemporaryDirectory(prefix="rotoxy-recovery-proof-") as directory:
        private = Path(directory)
        env = {"PATH": os.defpath, "HOME": directory,
               "TOKEN2OAUTH_CONFIG_DIR": str(private / "config"),
               "PYTHONPATH": str(root / "supervisor"), "PYTHONUNBUFFERED": "1"}
        inbox, state = private / "inbox.sqlite", private / "recovery.sqlite"
        policy = dict(level="notify", permissions=["notify"], rules={}, max_attempts=1,
                      max_runtime_seconds=10, action_budget_usd=0, budget_ceiling_usd=0,
                      oracle_advice=False, oracle_hourly_limit=0,
                      headless_adapter_verified=False)
        config = dict(version=1, inboxDb=str(inbox), stateDb=str(state),
                      intervalSeconds=60, maxEventsPerCycle=20,
                      projects=[dict(project="proof", scope="proof", owners=["proof-owner"], policy=policy),
                                dict(project="web-proof", scope="web-proof", owners=["proof-owner"],
                                     policy={**policy, "level": "human", "permissions": []})])
        config_path = private / "recovery.json"
        config_path.write_text(json.dumps(config))
        config_path.chmod(0o600)

        def producer(command, payload):
            result = subprocess.run([sys.executable, "-m", "snooze.guidance", "--db", str(inbox), command],
                                    input=json.dumps(payload), text=True, capture_output=True,
                                    env=env, cwd=root, timeout=20, check=True)
            return json.loads(result.stdout)

        # Registration is submitted by a separate initiator process that exits.
        for worker, project in (("worker-a", "proof"), ("worker-web", "web-proof")):
            producer("register", dict(worker=worker, project=project, owner="proof-owner",
                                      account="account-a", session=worker, model="observed-model"))
        initiator_exited = True
        producer("observe", dict(worker="worker-a", owner="proof-owner", job="proof",
                                 observation=dict(state="failed", model="observed-model", promptCount=1)))
        producer("observe", dict(worker="worker-web", owner="proof-owner", job="web-proof",
                                 observation=dict(state="idle", needsInput=True, model="observed-model",
                                                  promptCount=1, question=dict(text="Which branch should I review?",
                                                      source="provider", kind="question"))))

        def serve_until(expected):
            with (private / "service.log").open("a") as output:
                service = subprocess.Popen([sys.executable, "-m", "snooze.recovery_service",
                                            "--config", str(config_path), "serve"], env=env, cwd=root,
                                           stdin=subprocess.DEVNULL, stdout=output, stderr=output)
                try:
                    deadline = time.monotonic() + 20
                    while time.monotonic() < deadline:
                        if service.poll() is not None:
                            raise AssertionError("supervisor exited before recording incidents: " +
                                                 (private / "service.log").read_text()[-3000:])
                        try:
                            # A read-only probe must never create the database
                            # before the service has applied private permissions.
                            with sqlite3.connect(state.as_uri() + "?mode=ro", uri=True) as db:
                                count = db.execute("SELECT COUNT(*) FROM recovery_service_sources").fetchone()[0]
                            if count >= expected:
                                return
                        except sqlite3.Error:
                            pass
                        time.sleep(0.1)
                    raise AssertionError("supervisor did not persist incidents within 20 seconds")
                finally:
                    service.terminate()
                    try:
                        service.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        service.kill()
                        service.wait(timeout=5)

        serve_until(2)
        # A new event arrives while the supervisor is stopped. Restart must
        # recover it and preserve the first action's exactly-once receipt.
        producer("observe", dict(worker="worker-a", owner="proof-owner", job="proof",
                                 observation=dict(state="running", model="observed-model", promptCount=2)))
        producer("observe", dict(worker="worker-a", owner="proof-owner", job="proof",
                                 observation=dict(state="failed", model="observed-model", promptCount=2)))
        serve_until(4)
        replay = subprocess.run([sys.executable, "-m", "snooze.recovery_service", "--config", str(config_path), "--once"],
                                env=env, cwd=root, text=True, capture_output=True, timeout=20, check=True)
        assert json.loads(replay.stdout)["processed"] == 0
        with sqlite3.connect(state) as db:
            sources = db.execute("SELECT recovery_event_id,state FROM recovery_service_sources ORDER BY inbox_event_id").fetchall()
            notifications = db.execute("SELECT recovery_event_id,COUNT(*) FROM recovery_service_notifications GROUP BY recovery_event_id").fetchall()
            actions = db.execute("SELECT event_id,COUNT(*) FROM recovery_actions GROUP BY event_id").fetchall()
        with sqlite3.connect(inbox) as db:
            unacked = db.execute("SELECT COUNT(*) FROM guidance_events WHERE ack_at IS NULL").fetchone()[0]
        assert len(sources) == 4 and sources[1][1] == "handoff"
        assert len(notifications) == 3 and all(count == 1 for _, count in notifications)
        assert len(actions) == 3 and all(count == 1 for _, count in actions)
        assert unacked == 0
        projection = subprocess.run([sys.executable, "-m", "snooze.guidance", "--db", str(inbox),
                                    "project-snapshot", "--project", "web-proof", "--pool-config",
                                    str(private / "oracle" / "config.json"), "--pool-db",
                                    str(private / "oracle" / "queue.sqlite")], input=json.dumps({"owners": ["proof-owner"]}),
                                    env=env, cwd=root, text=True, capture_output=True, timeout=20, check=True)
        snapshot = json.loads(projection.stdout)
        assert snapshot["workers"][0]["question"]["text"] == "Which branch should I review?"
        assert snapshot["events"][0]["question"]["text"] == "Which branch should I review?"
        assert snapshot["events"][0]["accountId"] == "account-a"
        assert snapshot["events"][0]["sessionId"] == "worker-web"
        evidence = dict(passed=True, syntheticIncidents=True, providerCalls=0,
                        initiatorExited=initiator_exited, supervisorRestarted=True,
                        durableEvents=len(sources), notificationReceipts=len(notifications),
                        duplicateActions=0, dormantWebHandoff=True,
                        replayProcessed=0, questionProjection=True, productionStateTouched=False)
        if args.output:
            args.output.write_text(json.dumps(evidence, indent=2) + "\n")
        print(json.dumps(evidence, indent=2))


if __name__ == "__main__":
    main()
