import json
import contextlib
import io
import sqlite3
import subprocess
import sys
import os
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from snooze.oracle_pool import (
    _process_identity,
    APPROVED_MODELS,
    HOSTS,
    DEFAULT_MODEL,
    MAX_PENDING,
    OraclePool,
    PoolError,
    SSHOllamaTransport,
    _config_revision,
    APPLY_SCHEMA_MARKER,
    _serve_loop,
    read_daemon_status,
    read_config_apply_status,
)


class FakeTransport:
    def __init__(self):
        self.calls = []
        self.lock = threading.Lock()
        self.gate = None
        self.error = None
        self.catalog_failures = set()

    def catalog(self, host):
        if host in self.catalog_failures:
            raise PoolError("transport_exit")
        if self.error:
            raise self.error
        return list(APPROVED_MODELS)

    def generate(self, host, model, prompt):
        with self.lock:
            self.calls.append((host, model, prompt))
        if self.gate:
            self.gate.wait(timeout=5)
        if self.error:
            raise self.error
        return {"model": model, "response": "review result", "prompt_eval_count": 23,
                "eval_count": 41, "total_duration": 1_250_000_000}


class OraclePoolTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / "private"
        self.transport = FakeTransport()
        self.pool = OraclePool(self.root / "config.json", self.root / "queue.sqlite3", self.transport)

    def test_cli_batch_is_atomic_and_cancellation_is_structured(self):
        def cli(command, payload=None):
            result = subprocess.run([sys.executable, "-m", "snooze.oracle_pool",
                "--config", str(self.pool.config_path), "--db", str(self.pool.db_path),
                *command], input=json.dumps(payload) if payload else None,
                text=True, capture_output=True, timeout=10)
            return result.returncode, json.loads(result.stdout)
        request = {"tasks": [{"job_id": "cli-a", "text": "first"},
                             {"job_id": "cli-b", "text": "second"}]}
        code, rows = cli(["submit-batch", "--stdin-json"], request)
        self.assertEqual(code, 0)
        self.assertEqual([r["id"] for r in rows], ["cli-a", "cli-b"])
        self.assertEqual(cli(["submit-batch", "--stdin-json"], request)[0], 0)
        code, error = cli(["submit-batch", "--stdin-json"], {"tasks": [
            {"job_id": "cli-new", "text": "new"}, {"job_id": "cli-a", "text": "conflict"}]})
        self.assertEqual(code, 2)
        self.assertIn("different content", error["error"])
        with self.assertRaises(KeyError):
            self.pool.status("cli-new")
        code, receipt = cli(["cancel", "--id", "cli-a"])
        self.assertEqual(code, 0)
        self.assertEqual(receipt["status"], "cancelled")
        self.assertTrue(receipt["cancelled"])
        with self.pool._connect() as db:
            db.execute("UPDATE pool_tasks SET status='running',claim_pid=?,claim_boot=?,claim_start=? WHERE id='cli-b'", _process_identity())
            db.commit()
        code, error = cli(["cancel", "--id", "cli-b"])
        self.assertEqual(code, 2)
        self.assertEqual(error["error"], "task_inference_not_cancellable")

    def test_default_paths_prefer_existing_legacy_state_and_canonical_when_present(self):
        with tempfile.TemporaryDirectory() as home, patch.dict(os.environ, {"HOME": home}):
            legacy = Path(home) / ".local/state/token2oauth/oracle-pool"
            legacy.mkdir(parents=True)
            (legacy / "queue.sqlite3").touch()
            unrelated = Path(home) / ".local/state/rotoxy/supervision"
            unrelated.mkdir(parents=True)
            (unrelated / "inbox.sqlite").touch()
            pool = OraclePool(transport=FakeTransport())
            self.assertEqual(pool.db_path, legacy / "queue.sqlite3")
            self.assertEqual(pool.config_path, legacy / "config.json")
            canonical = Path(home) / ".local/state/rotoxy/oracle-pool"
            OraclePool(canonical / "config.json", canonical / "queue.sqlite3", FakeTransport())
            # A canonical state marker takes precedence; old files remain untouched.
            fresh = OraclePool(transport=FakeTransport())
            self.assertEqual(fresh.db_path, canonical / "queue.sqlite3")
            self.assertTrue((legacy / "queue.sqlite3").exists())

    def test_default_private_state_and_fixed_ssh_policy(self):
        self.assertEqual(self.pool.config_path.stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.pool.db_path.stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.pool.base.stat().st_mode & 0o777, 0o700)
        self.assertEqual([h["id"] for h in HOSTS], ["ora1", "ora3", "ora5"])
        with self.assertRaises(PoolError):
            SSHOllamaTransport._host("ora2")
        with self.assertRaises(ValueError):
            self.pool.submit("x" * 4001)
        with self.assertRaises(ValueError):
            self.pool.submit("bounded task", model="unapproved-model")

    def _fleet_config(self, hosts):
        return {"version": 2, "default_model": DEFAULT_MODEL, "max_context": 4096,
                "max_predict": 512, "max_total_running": 3, "max_running_per_host": 1,
                "inference_timeout_seconds": 240, "hosts": hosts}

    def _new_fleet(self, hosts, name="fleet"):
        root = self.root / name
        root.mkdir(parents=True, exist_ok=True)
        config = root / "config.json"
        config.write_text(json.dumps(self._fleet_config(hosts)), encoding="utf-8")
        config.chmod(0o600)
        return OraclePool(config, root / "queue.sqlite3", FakeTransport())

    def test_v2_fourth_host_joins_catalog_and_fair_dispatch(self):
        hosts = [{**host, "enabled": True, "allowedModels": list(APPROVED_MODELS)} for host in HOSTS]
        hosts.append({"id": "ora7", "ip": "100.68.1.7", "ssh_host": "shh-ora7.ziopsyop.tech",
                      "enabled": True, "allowedModels": [DEFAULT_MODEL]})
        pool = self._new_fleet(hosts)
        pool.catalog(refresh=True)
        for i in range(4):
            pool.submit(f"fourth host task {i}", job_id=f"fleet:{i}")
        self.assertEqual(pool.run_once()["claimed"], 3)
        self.assertEqual(pool.run_once()["claimed"], 1)
        self.assertIn("ora7", {row["id"] for row in pool.catalog()["hosts"]})
        self.assertIn(("ora7", DEFAULT_MODEL, "fourth host task 3"), pool.transport.calls)

    def test_disabled_host_is_not_probed_or_selected_for_new_dispatch(self):
        hosts = [{**host, "enabled": host["id"] != "ora3", "allowedModels": list(APPROVED_MODELS)} for host in HOSTS]
        pool = self._new_fleet(hosts, "disabled")
        pool.catalog(refresh=True)
        for i in range(3):
            pool.submit(f"disabled host task {i}", job_id=f"disabled:{i}")
        outcome = pool.run_once()
        self.assertEqual(outcome["claimed"], 2)
        self.assertNotIn("ora3", {row["host"] for row in outcome["completed"]})
        disabled = next(row for row in pool.catalog()["hosts"] if row["id"] == "ora3")
        self.assertFalse(disabled["enabled"])

    def test_per_host_allowed_models_are_enforced_at_claim(self):
        hosts = [{**host, "enabled": True,
                  "allowedModels": ["gpt-oss:20b"] if host["id"] == "ora1" else
                                   [DEFAULT_MODEL] if host["id"] == "ora3" else ["gpt-oss:20b"]}
                 for host in HOSTS]
        pool = self._new_fleet(hosts, "model-policy")
        pool.catalog(refresh=True)
        pool.submit("route gpt model", model="gpt-oss:20b", job_id="model:gpt")
        pool.submit("route qwen model", model=DEFAULT_MODEL, job_id="model:qwen")
        outcome = pool.run_once()
        assignments = {row["id"]: row["host"] for row in outcome["completed"]}
        self.assertEqual(assignments["model:gpt"], "ora1")
        self.assertEqual(assignments["model:qwen"], "ora3")

    def test_v2_rejects_invalid_tailnet_ip_alias_host_and_model(self):
        host = {"id": "ora9", "ip": "100.68.1.9", "ssh_host": "shh-ora9.ziopsyop.tech",
                "enabled": True, "allowedModels": [DEFAULT_MODEL]}
        for field, invalid in (("ip", "127.0.0.1"), ("ssh_host", "ora9;touch /tmp/pwned"),
                               ("id", "ora9;bad"), ("allowedModels", ["qwen ;bad"])):
            bad = dict(host)
            bad[field] = invalid
            with self.subTest(field=field), self.assertRaises(PoolError):
                self._new_fleet([bad], f"invalid-{field}")

    def test_ssh_transport_uses_only_pinned_strict_host_and_payload_stdin(self):
        transport = SSHOllamaTransport()
        with patch("snooze.oracle_pool.shutil.which", return_value="/usr/bin/ssh"), patch(
                "snooze.oracle_pool.subprocess.run",
                return_value=type("Proc", (), {"returncode": 0, "stdout": b"{}"})()) as run:
            transport._ssh("ora3", "print('fixed script')", b"private task text", timeout=2)
        argv = run.call_args.args[0]
        self.assertIn("ora3", argv)
        self.assertIn("HostName=100.114.191.111", argv)
        self.assertIn("HostKeyAlias=[shh-ora3.ziopsyop.tech]:6722", argv)
        self.assertIn("StrictHostKeyChecking=yes", argv)
        self.assertNotIn("StrictHostKeyChecking=no", argv)
        self.assertEqual(run.call_args.kwargs["input"], b"private task text")
        self.assertNotIn(b"private task text", " ".join(argv).encode())

    def test_generate_request_has_fixed_text_only_bounds_and_no_tool_contract(self):
        transport = SSHOllamaTransport()
        captured = {}

        def fake_ssh(host, script, payload, *, timeout):
            captured.update(host=host, script=script, payload=json.loads(payload), timeout=timeout)
            return {"model": DEFAULT_MODEL, "response": "ok"}

        with patch.object(transport, "_ssh", side_effect=fake_ssh):
            transport.generate("ora1", DEFAULT_MODEL, "summarize a bounded finding")
        self.assertEqual(captured["payload"]["model"], DEFAULT_MODEL)
        self.assertFalse(captured["payload"]["think"])
        self.assertEqual(captured["payload"]["options"], {"num_ctx": 4096, "num_predict": 512})
        self.assertFalse(captured["payload"]["stream"])
        self.assertNotIn("tools", captured["payload"])
        self.assertEqual(captured["timeout"], 240)

    def test_idempotent_submit_requires_identical_text_model_and_source(self):
        first = self.pool.submit("review task", model=DEFAULT_MODEL, job_id="event:review-1", source="event:123")
        second = self.pool.submit("review task", model=DEFAULT_MODEL, job_id="event:review-1", source="event:123")
        self.assertEqual(first["id"], second["id"])
        for kwargs in ({"model": "tev1:0.8b"}, {"source": "event:124"}):
            with self.assertRaisesRegex(ValueError, "different content"):
                self.pool.submit("review task", job_id="event:review-1", **kwargs)

    def test_batch_is_indivisible_atomic_idempotent_and_fair_across_hosts(self):
        self.pool.catalog(refresh=True)
        batch = [{"text": f"independent subtask {i}", "job_id": f"batch:{i}", "source": "event:batch"}
                 for i in range(3)]
        first = self.pool.submit_batch(batch)
        retry = self.pool.submit_batch(batch)
        self.assertEqual([row["id"] for row in first], [row["id"] for row in retry])
        self.assertEqual([row["status"] for row in first], ["queued"] * 3)

        outcome = self.pool.run_once()

        self.assertEqual(outcome["claimed"], 3)
        self.assertEqual({row["host"] for row in outcome["completed"]}, {"ora1", "ora3", "ora5"})
        self.assertEqual({call[2] for call in self.transport.calls}, {item["text"] for item in batch})
        with self.assertRaisesRegex(ValueError, "different content"):
            self.pool.submit_batch([{"text": "changed", "job_id": "batch:0"},
                                    {"text": "must not partially insert", "job_id": "batch:new"}])
        with self.assertRaises(KeyError):
            self.pool.status("batch:new")
        with self.assertRaisesRegex(ValueError, "Duplicate task ID"):
            self.pool.submit_batch([{"text": "one", "job_id": "duplicate"},
                                    {"text": "two", "job_id": "duplicate"}])

    def test_batch_capacity_is_atomic_and_bounded(self):
        for index in range(MAX_PENDING - 1):
            self.pool.submit(f"queued {index}", job_id=f"capacity:{index}")
        with self.assertRaisesRegex(PoolError, "queue_full"):
            self.pool.submit_batch([{"text": "first", "job_id": "capacity:new-1"},
                                    {"text": "second", "job_id": "capacity:new-2"}])
        self.assertEqual(self.pool.status()["counts"]["queued"], MAX_PENDING - 1)
        with self.assertRaisesRegex(ValueError, "Batch must contain"):
            self.pool.submit_batch([{"text": "x"}] * 13)

    def test_catalog_failure_skips_stale_host_and_recovers_when_refreshed(self):
        self.transport.catalog_failures.add("ora3")
        catalog = self.pool.catalog(refresh=True)
        self.assertEqual(next(row for row in catalog["hosts"] if row["id"] == "ora3")["error_code"],
                         "transport_exit")
        for index in range(3):
            self.pool.submit(f"fallback {index}", job_id=f"fallback:{index}")
        outcome = self.pool.run_once()
        self.assertEqual(outcome["claimed"], 2)
        self.assertNotIn("ora3", {row["host"] for row in outcome["completed"]})
        self.assertEqual(self.pool.status("fallback:2")["status"], "queued")

        self.transport.catalog_failures.clear()
        self.pool.catalog(refresh=True)
        self.assertEqual(self.pool.run_once()["claimed"], 1)
        self.assertEqual(self.pool.status("fallback:2")["status"], "complete")

    def test_cancel_only_removes_queued_work_and_is_idempotent(self):
        self.pool.catalog(refresh=True)
        task = self.pool.submit("do not dispatch", job_id="cancel:queued")
        cancelled = self.pool.cancel(task["id"])
        self.assertEqual(cancelled, {"id": "cancel:queued", "status": "cancelled", "cancelled": True})
        self.assertTrue(self.pool.cancel(task["id"])["cancelled"])
        self.assertEqual(self.pool.run_once()["claimed"], 0)
        self.assertEqual(self.pool.results(task["id"])["status"], "cancelled")

    def test_dispatched_inference_cannot_be_cancelled_or_replayed(self):
        self.pool.catalog(refresh=True)
        task = self.pool.submit("in flight", job_id="cancel:running")
        self.transport.gate = threading.Event()
        thread = threading.Thread(target=self.pool.run_once)
        thread.start()
        deadline = time.monotonic() + 2
        while self.pool.status(task["id"])["status"] != "running" and time.monotonic() < deadline:
            time.sleep(0.01)
        with self.assertRaisesRegex(PoolError, "not_cancellable"):
            self.pool.cancel(task["id"])
        self.assertEqual(self.pool.status(task["id"])["status"], "running")
        self.transport.gate.set()
        thread.join(timeout=5)
        self.assertFalse(thread.is_alive())
        self.assertEqual(len(self.transport.calls), 1)

    def test_three_host_fair_distribution_and_safe_durable_evidence(self):
        self.pool.catalog(refresh=True)
        ids = [f"review-{index}" for index in range(3)]
        for task_id in ids:
            self.pool.submit(f"bounded private prompt for {task_id}", job_id=task_id, source="event:77")

        outcome = self.pool.run_once()

        self.assertEqual(outcome["claimed"], 3)
        self.assertEqual({row["host"] for row in outcome["completed"]}, {"ora1", "ora3", "ora5"})
        self.assertEqual({row["status"] for row in outcome["completed"]}, {"complete"})
        self.assertEqual({call[1] for call in self.transport.calls}, {DEFAULT_MODEL})
        for task_id in ids:
            result = self.pool.results(task_id)
            self.assertEqual(result["result"], "review result")
            self.assertEqual(result["prompt_tokens"], 23)
            self.assertEqual(result["eval_tokens"], 41)
            self.assertEqual(result["actual_model"], DEFAULT_MODEL)
            self.assertGreaterEqual(result["elapsed_seconds"], 0)
        events = self.pool.events(limit=100)["events"]
        encoded = json.dumps(events)
        complete = next(event for event in events if event["kind"] == "complete")
        self.assertEqual(complete["prompt_tokens"], 23)
        self.assertNotIn("bounded private prompt", encoded)
        self.assertNotIn("review result", encoded)
        self.assertEqual(self.pool.status(task_id)["assigned_host"] in {"ora1", "ora3", "ora5"}, True)

    def test_global_three_running_limit_and_one_per_host_across_pool_instances(self):
        self.pool.catalog(refresh=True)
        for index in range(4):
            self.pool.submit(f"task {index}", job_id=f"job-{index}")
        self.transport.gate = threading.Event()
        thread = threading.Thread(target=self.pool.run_once)
        thread.start()
        deadline = time.monotonic() + 2
        while len(self.transport.calls) < 3 and time.monotonic() < deadline:
            time.sleep(0.01)
        self.assertEqual(len(self.transport.calls), 3)
        another = OraclePool(self.pool.config_path, self.pool.db_path, self.transport)
        outcome = another.run_once()
        self.assertEqual(outcome["claimed"], 0)
        self.assertEqual(another.status()["counts"]["running"], 3)
        self.transport.gate.set()
        thread.join(timeout=5)
        self.assertFalse(thread.is_alive())
        self.assertEqual(len({host for host, _model, _prompt in self.transport.calls}), 3)

    def test_timeout_is_ambiguous_and_never_blindly_retried(self):
        self.pool.catalog(refresh=True)
        self.pool.submit("review once", job_id="ambiguous")
        self.transport.error = PoolError("timeout")

        outcome = self.pool.run_once()

        self.assertEqual(outcome["completed"][0]["status"], "ambiguous")
        self.assertEqual(self.pool.status("ambiguous")["attempts"], 1)
        self.transport.error = None
        self.assertEqual(self.pool.run_once()["claimed"], 0)
        self.assertEqual(self.pool.results("ambiguous")["error_code"], "timeout")

    def test_http_server_error_is_ambiguous_but_request_rejection_is_failed(self):
        self.pool.catalog(refresh=True)
        self.transport.error = PoolError("remote_http_500")
        self.pool.submit("possibly accepted by server", job_id="http-500")
        self.assertEqual(self.pool.run_once()["completed"][0]["status"], "ambiguous")
        self.transport.error = PoolError("remote_http_400")
        self.pool.submit("rejected request", job_id="http-400")
        self.assertEqual(self.pool.run_once()["completed"][0]["status"], "failed")
        self.assertEqual(self.pool.status("http-500")["attempts"], 1)
        self.assertEqual(self.pool.status("http-400")["attempts"], 1)

    def test_empty_run_is_idle_and_cleanup_only_removes_old_terminal_rows(self):
        self.pool.catalog(refresh=True)
        self.assertEqual(self.pool.run_once()["claimed"], 0)
        self.assertEqual(self.transport.calls, [])
        terminal = self.pool.submit("old terminal", job_id="old-terminal")
        queued = self.pool.submit("keep queued", job_id="keep-queued")
        with self.pool._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            db.execute("UPDATE pool_tasks SET status='complete',updated=? WHERE id=?",
                       (time.time() - 40 * 86400, terminal["id"]))
            db.execute("UPDATE pool_events SET at=? WHERE task_id=?",
                       (time.time() - 40 * 86400, terminal["id"]))
            db.commit()

        outcome = self.pool.cleanup(older_than_seconds=30 * 86400)

        self.assertEqual(outcome["tasks_deleted"], 1)
        with self.assertRaises(KeyError):
            self.pool.status(terminal["id"])
        self.assertEqual(self.pool.status(queued["id"])["status"], "queued")

    def test_restart_marks_dead_worker_claim_ambiguous_instead_of_requeueing(self):
        task = self.pool.submit("possibly sent", job_id="crash")
        with self.pool._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            db.execute("UPDATE pool_tasks SET status='running',assigned_host='ora1',claim_token='old',claim_pid=99999999,claim_boot='dead',claim_start='dead' WHERE id=?", (task["id"],))
            db.commit()

        restarted = OraclePool(self.pool.config_path, self.pool.db_path, self.transport)

        self.assertEqual(restarted.status("crash")["status"], "ambiguous")
        self.assertEqual(restarted.status("crash")["attempts"], 0)
        self.assertEqual(restarted.run_once()["claimed"], 0)

    def test_catalog_failure_preserves_last_known_inventory_and_queue_is_bounded(self):
        self.pool.catalog(refresh=True)
        before = self.pool.catalog()["hosts"]
        self.transport.error = PoolError("transport_exit")
        after = self.pool.catalog(refresh=True)["hosts"]
        for host_before, host_after in zip(before, after):
            self.assertEqual(host_before["models"], host_after["models"])
            self.assertEqual(host_after["error_code"], "transport_exit")
        self.transport.error = None
        for index in range(MAX_PENDING):
            self.pool.submit(f"bounded {index}", job_id=f"queue-{index}")
        with self.assertRaisesRegex(PoolError, "queue_full"):
            self.pool.submit("one too many")


    def test_durable_maintenance_fence_drains_and_preserves_queued_work(self):
        from snooze.oracle_pool import read_maintenance_status
        revision = "R" * 24
        self.pool.catalog(refresh=True)
        queued = self.pool.submit("preserve during maintenance", job_id="maint-queued")
        initial = self.pool.maintenance_status()
        self.assertEqual(set(initial), {"epoch", "paused", "configRevision", "acknowledged", "blockers", "reason"})
        self.assertEqual(initial, {"epoch": 0, "paused": False, "configRevision": None, "acknowledged": False,
                                  "blockers": {"running": 0, "ambiguous": 0, "dispatching": 0}, "reason": None})
        requested = self.pool.request_maintenance(revision, 0)
        self.assertEqual((requested["epoch"], requested["paused"], requested["acknowledged"]), (1, True, False))
        self.assertEqual(self.pool.request_maintenance(revision, 0), requested)  # matching retry only
        before = self.pool.db_path.read_bytes()
        self.assertEqual(read_maintenance_status(self.pool.db_path), requested)
        self.assertEqual(self.pool.db_path.read_bytes(), before)
        restarted = OraclePool(self.pool.config_path, self.pool.db_path, FakeTransport())
        restarted.register_daemon()
        self.assertFalse(restarted.maintenance_status()["acknowledged"])
        self.assertEqual(restarted._claim(), [])
        ack = restarted.maintenance_status()
        self.assertTrue(ack["acknowledged"])
        self.assertEqual(restarted.status("maint-queued")["status"], "queued")
        self.assertEqual(read_maintenance_status(self.pool.db_path), ack)
        released = restarted.release_maintenance(expected_epoch=1, config_revision=revision)
        self.assertEqual((released["epoch"], released["paused"], released["configRevision"]), (2, False, None))
        with self.assertRaisesRegex(ValueError, "maintenance_epoch_conflict"):
            restarted.release_maintenance(expected_epoch=1, config_revision=revision)
        with self.assertRaisesRegex(ValueError, "maintenance_revision_conflict"):
            restarted.release_maintenance(expected_epoch=2, config_revision=revision)

    def test_maintenance_ack_waits_for_running_and_ambiguous_tasks_and_unknown_blocks(self):
        revision = "M" * 24
        self.pool.submit("running", job_id="maint-running")
        self.pool.submit("ambiguous", job_id="maint-ambiguous")
        with self.pool._connect() as db:
            db.execute("UPDATE pool_tasks SET status='running' WHERE id='maint-running'")
            db.execute("UPDATE pool_tasks SET status='ambiguous' WHERE id='maint-ambiguous'")
            db.commit()
        self.pool.register_daemon()
        requested = self.pool.request_maintenance(revision, 0)
        self.assertEqual(requested["blockers"], {"running": 1, "ambiguous": 1, "dispatching": 0})
        self.assertFalse(self.pool._claim())
        self.assertFalse(self.pool.maintenance_status()["acknowledged"])
        with self.pool._connect() as db:
            db.execute("UPDATE pool_tasks SET status='complete' WHERE id='maint-running'")
            db.commit()
        self.pool._claim()
        self.assertFalse(self.pool.maintenance_status()["acknowledged"])
        with self.pool._connect() as db:
            db.execute("UPDATE pool_tasks SET status='complete' WHERE id='maint-ambiguous'")
            db.execute("INSERT INTO pool_tasks(id,text,text_hash,model,status,created,updated) VALUES('unknown','x','x',?,'mystery',1,1)", (DEFAULT_MODEL,))
            db.commit()
        self.pool._claim()
        status = self.pool.maintenance_status()
        self.assertEqual(status["blockers"]["dispatching"], 1)
        self.assertFalse(status["acknowledged"])
        with self.pool._connect() as db:
            db.execute("DELETE FROM pool_tasks WHERE id='unknown'")
            db.commit()
        self.pool._claim()
        self.assertTrue(self.pool.maintenance_status()["acknowledged"])

    def test_maintenance_request_races_with_claim_across_pool_instances(self):
        self.pool.catalog(refresh=True)
        self.pool.submit("claim-or-pause", job_id="maint-race")
        peer = OraclePool(self.pool.config_path, self.pool.db_path, FakeTransport())
        peer.register_daemon()
        barrier = threading.Barrier(2)
        results = {}
        def claim():
            barrier.wait(); results["claim"] = peer._claim()
        def request():
            barrier.wait(); results["request"] = self.pool.request_maintenance("C" * 24, 0)
        threads = [threading.Thread(target=claim), threading.Thread(target=request)]
        for thread in threads: thread.start()
        for thread in threads: thread.join(timeout=5)
        self.assertTrue(all(not thread.is_alive() for thread in threads))
        self.assertTrue(results["request"]["paused"])
        self.assertIn(len(results["claim"]), (0, 1))
        self.assertEqual(peer._claim(), [])
        status = peer.maintenance_status()
        self.assertTrue(status["paused"])
        if results["claim"]:
            self.assertEqual(status["blockers"]["running"], 1)
            self.assertFalse(status["acknowledged"])
        else:
            self.assertTrue(status["acknowledged"])

    def test_maintenance_cli_status_request_and_release(self):
        def cli(*args):
            result = subprocess.run([sys.executable, "-m", "snooze.oracle_pool", "--config", str(self.pool.config_path),
                "--db", str(self.pool.db_path), *args], text=True, capture_output=True, timeout=10)
            return result.returncode, json.loads(result.stdout)
        code, status = cli("maintenance-status")
        self.assertEqual(code, 0); self.assertEqual(status["epoch"], 0)
        missing = Path(self.temp.name) / "maintenance-cli-missing.sqlite"
        result = subprocess.run([sys.executable, "-m", "snooze.oracle_pool", "--db", str(missing), "maintenance-status"],
                                text=True, capture_output=True, timeout=10)
        self.assertEqual(result.returncode, 2); self.assertFalse(missing.exists())
        code, paused = cli("maintenance-request", "--revision", "D" * 24, "--epoch", "0")
        self.assertEqual(code, 0); self.assertTrue(paused["paused"])
        code, resumed = cli("maintenance-release", "--revision", "D" * 24, "--epoch", "1")
        self.assertEqual(code, 0); self.assertEqual(resumed["epoch"], 2); self.assertFalse(resumed["paused"])

    def test_deleted_or_empty_existing_fence_fails_closed_on_restart(self):
        self.pool.request_maintenance("X" * 24, 0)
        with self.pool._connect() as db:
            db.execute("DELETE FROM pool_maintenance WHERE id=1")
            db.commit()
        with self.assertRaisesRegex(ValueError, "maintenance_unavailable"):
            OraclePool(self.pool.config_path, self.pool.db_path, FakeTransport())
        empty_root = Path(self.temp.name) / "empty-existing-fence"
        empty_root.mkdir(mode=0o700)
        config = empty_root / "config.json"
        config.write_text(json.dumps(self.pool.config), encoding="utf-8")
        config.chmod(0o600)
        empty_db = empty_root / "queue.sqlite3"
        with sqlite3.connect(empty_db) as db:
            db.execute("CREATE TABLE pool_maintenance(id INTEGER PRIMARY KEY CHECK(id=1),epoch INTEGER NOT NULL,paused INTEGER NOT NULL,config_revision TEXT,acknowledged INTEGER NOT NULL,requested_at REAL)")
        empty_db.chmod(0o600)
        with self.assertRaisesRegex(ValueError, "maintenance_unavailable"):
            OraclePool(config, empty_db, FakeTransport())

    def test_legacy_database_migration_initializes_fence_once_and_preserves_tasks(self):
        task = self.pool.submit("legacy queued task", job_id="legacy-maint-task")
        with self.pool._connect() as db:
            db.execute("DROP TABLE pool_maintenance")
            db.commit()
        migrated = OraclePool(self.pool.config_path, self.pool.db_path, FakeTransport())
        self.assertEqual(migrated.maintenance_status()["epoch"], 0)
        self.assertFalse(migrated.maintenance_status()["paused"])
        self.assertEqual(migrated.status(task["id"])["status"], "queued")

    def test_concurrent_first_legacy_migration_creates_one_initial_fence_row(self):
        root = Path(self.temp.name) / "parallel-init"
        root.mkdir(mode=0o700)
        config = root / "config.json"
        config.write_text(json.dumps(self.pool.config), encoding="utf-8")
        config.chmod(0o600)
        db_path = root / "queue.sqlite3"
        barrier = threading.Barrier(6)
        results, errors = [], []
        def construct():
            try:
                barrier.wait(timeout=5)
                pool = OraclePool(config, db_path, FakeTransport())
                results.append(pool.maintenance_status())
            except Exception as exc:
                errors.append(exc)
        threads = [threading.Thread(target=construct) for _ in range(6)]
        for thread in threads: thread.start()
        for thread in threads: thread.join(timeout=10)
        self.assertTrue(all(not thread.is_alive() for thread in threads))
        self.assertEqual(errors, [])
        self.assertEqual(len(results), 6)
        self.assertTrue(all(status["epoch"] == 0 and not status["paused"] for status in results))
        with sqlite3.connect(db_path) as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM pool_maintenance").fetchone()[0], 1)

    def test_open_maintenance_is_existing_state_only_and_does_not_recover_claims(self):
        from snooze.oracle_pool import read_maintenance_status
        missing = Path(self.temp.name) / "missing" / "queue.sqlite3"
        with self.assertRaisesRegex(ValueError, "maintenance_unavailable"):
            OraclePool.open_maintenance(missing)
        self.assertFalse(missing.parent.exists())
        task = self.pool.submit("possibly dispatched", job_id="maint-open-existing")
        with self.pool._connect() as db:
            db.execute("UPDATE pool_tasks SET status='running',claim_pid=99999999,claim_boot='gone',claim_start='gone' WHERE id=?", (task["id"],))
            db.commit()
        before = self.pool.db_path.read_bytes()
        controller = OraclePool.open_maintenance(self.pool.db_path)
        self.assertEqual(controller.maintenance_status()["blockers"]["running"], 1)
        self.assertEqual(self.pool.status(task["id"])["status"], "running")
        self.assertEqual(self.pool.db_path.read_bytes(), before)
        self.assertEqual(read_maintenance_status(self.pool.db_path)["blockers"]["running"], 1)
        self.pool.db_path.unlink()
        with self.assertRaisesRegex(ValueError, "maintenance_unavailable"):
            controller.maintenance_status()
        self.assertFalse(self.pool.db_path.exists())

    def test_maintenance_fence_cas_and_readonly_helper_fail_closed(self):
        import sqlite3
        from snooze.oracle_pool import read_maintenance_status
        with self.assertRaisesRegex(ValueError, "maintenance_epoch_conflict"):
            self.pool.request_maintenance("B" * 24, 1)
        with self.assertRaisesRegex(ValueError, "maintenance_revision_conflict"):
            self.pool.request_maintenance("invalid", 0)
        with self.assertRaisesRegex(ValueError, "maintenance_epoch_conflict"):
            self.pool.request_maintenance("B" * 24, True)
        absent = Path(self.temp.name) / "does-not-exist.sqlite"
        with self.assertRaisesRegex(ValueError, "maintenance_unavailable"):
            read_maintenance_status(absent)
        empty = Path(self.temp.name) / "empty.sqlite"
        sqlite3.connect(empty).close(); empty.chmod(0o600)
        with self.assertRaisesRegex(ValueError, "maintenance_unavailable"):
            read_maintenance_status(empty)
        link = Path(self.temp.name) / "linked.sqlite"
        link.symlink_to(self.pool.db_path)
        with self.assertRaisesRegex(ValueError, "maintenance_unavailable"):
            read_maintenance_status(link)
        with self.pool._connect() as db:
            db.execute("UPDATE pool_maintenance SET paused=2 WHERE id=1")
            db.commit()
        with self.assertRaisesRegex(ValueError, "maintenance_unavailable"):
            self.pool.maintenance_status()
        with self.assertRaisesRegex(ValueError, "maintenance_unavailable"):
            read_maintenance_status(self.pool.db_path)

    def test_maintenance_transitions_have_one_durable_sanitized_audit_event(self):
        token = "E" * 24
        self.pool.request_maintenance(token, 0)
        self.pool.request_maintenance(token, 0)
        self.pool.register_daemon()
        self.pool._claim()
        self.pool._claim()
        self.pool.release_maintenance(expected_epoch=1, config_revision=token)
        with self.pool._connect() as db:
            rows = db.execute("SELECT kind,data FROM pool_events WHERE kind LIKE 'maintenance_%' ORDER BY id").fetchall()
        self.assertEqual([r["kind"] for r in rows], ["maintenance_requested", "maintenance_acknowledged", "maintenance_released"])
        data = [json.loads(r["data"]) for r in rows]
        self.assertEqual([x["epoch"] for x in data], [1, 1, 2])
        self.assertTrue(data[1]["acknowledged"])
        self.assertFalse(data[-1]["paused"])
        self.assertTrue(all(set(x) == {"epoch", "config_revision", "paused", "acknowledged"} for x in data))

    def test_loaded_revision_hashes_exact_bytes_parsed_once(self):
        raw = self.pool.config_path.read_bytes()
        self.assertEqual(self.pool.loaded_revision, _config_revision(raw))
        alternative = json.dumps(self.pool.config, separators=(",", ":")).encode()
        self.pool.config_path.write_bytes(alternative)
        self.assertNotEqual(self.pool.loaded_revision, _config_revision(self.pool.config_path.read_bytes()))
        self.assertEqual(self.pool.loaded_revision, _config_revision(raw))

    def test_daemon_registration_is_serve_owned_unique_and_claim_heartbeats(self):
        self.assertEqual(read_daemon_status(self.pool.db_path),
                         {"available": True, "instanceId": None, "loadedRevision": None,
                          "heartbeatAt": None, "observedEpoch": None, "alive": False})
        started = self.pool.register_daemon()
        self.assertEqual(started["loadedRevision"], self.pool.loaded_revision)
        self.assertEqual(started["observedEpoch"], 0)
        peer = OraclePool(self.pool.config_path, self.pool.db_path, FakeTransport())
        with self.assertRaisesRegex(ValueError, "daemon_already_registered"):
            peer.register_daemon()
        before = read_daemon_status(self.pool.db_path)
        self.pool.request_maintenance("H" * 24, 0)
        self.pool._claim()
        after = read_daemon_status(self.pool.db_path)
        self.assertEqual(after["instanceId"], started["instanceId"])
        self.assertEqual(after["observedEpoch"], 1)
        self.assertTrue(after["alive"])
        self.assertTrue(self.pool.maintenance_status()["acknowledged"])
        self.assertLessEqual(after["heartbeatAt"], time.time())
        self.assertGreaterEqual(after["heartbeatAt"], before["heartbeatAt"])

    def test_heartbeat_refresh_does_not_acknowledge_or_observe_paused_epoch(self):
        self.pool.register_daemon()
        self.pool.request_maintenance("J" * 24, 0)
        before = read_daemon_status(self.pool.db_path)
        time.sleep(0.002)
        heartbeat_at = self.pool.heartbeat_daemon()
        after = read_daemon_status(self.pool.db_path)
        self.assertGreaterEqual(heartbeat_at, before["heartbeatAt"])
        self.assertEqual(after["observedEpoch"], before["observedEpoch"])
        self.assertFalse(self.pool.maintenance_status()["acknowledged"])

    def test_serve_loop_heartbeats_during_blocked_execution_and_joins(self):
        self.pool.register_daemon()
        self.pool.catalog(refresh=True)
        self.pool.transport.gate = threading.Event()
        self.pool.submit("blocked fake inference", job_id="heartbeat-running")
        before = read_daemon_status(self.pool.db_path)["heartbeatAt"]
        stopped = threading.Event()
        failures = []

        def serve():
            try:
                with contextlib.redirect_stdout(io.StringIO()):
                    _serve_loop(self.pool, stopped, heartbeat_interval=0.02)
            except Exception as exc:
                failures.append(exc)

        thread = threading.Thread(target=serve)
        thread.start()
        try:
            deadline = time.monotonic() + 2
            while not self.transport.calls and time.monotonic() < deadline:
                time.sleep(0.005)
            self.assertTrue(self.transport.calls, "fake inference did not start")
            deadline = time.monotonic() + 2
            while read_daemon_status(self.pool.db_path)["heartbeatAt"] <= before and time.monotonic() < deadline:
                time.sleep(0.005)
            during = read_daemon_status(self.pool.db_path)
            self.assertGreater(during["heartbeatAt"], before)
            self.assertEqual(self.pool.status("heartbeat-running")["status"], "running")
        finally:
            stopped.set()
            self.pool.transport.gate.set()
            thread.join(timeout=2)
        self.assertFalse(thread.is_alive(), "serve loop did not join its heartbeat thread")
        self.assertEqual(failures, [])

    def test_begin_apply_requires_registered_observing_daemon_and_deduplicates(self):
        revision = "A" * 24
        self.pool.request_maintenance(revision, 0)
        with self.assertRaisesRegex(ValueError, "maintenance_not_drained|daemon_not_ready"):
            self.pool.begin_config_apply(expected_epoch=1, target_revision=revision)
        self.pool.register_daemon()
        self.pool._claim()
        controller = OraclePool.open_maintenance(self.pool.db_path)
        op = controller.begin_config_apply(expected_epoch=1, target_revision=revision)
        self.assertEqual(set(op), {"applyId", "epoch", "targetRevision", "previousInstance", "status", "error"})
        self.assertEqual(op["status"], "prepared")
        self.assertEqual(controller.begin_config_apply(expected_epoch=1, target_revision=revision), op)
        with self.assertRaisesRegex(ValueError, "config_apply_conflict"):
            controller.begin_config_apply(expected_epoch=1, target_revision="B" * 24)
        with self.assertRaisesRegex(ValueError, "config_apply_reserved"):
            controller.release_maintenance(expected_epoch=1, config_revision=revision)
        self.assertEqual(read_config_apply_status(self.pool.db_path), op)

    def test_apply_completion_requires_replacement_instance_and_exact_loaded_revision(self):
        original = self.pool.register_daemon()
        target_bytes = json.dumps(self.pool.config, separators=(",", ":")).encode()
        target = _config_revision(target_bytes)
        old_revision = self.pool.loaded_revision
        self.assertNotEqual(old_revision, target)
        self.pool.request_maintenance(old_revision, 0)
        self.pool._claim()
        controller = OraclePool.open_maintenance(self.pool.db_path)
        op = controller.begin_config_apply(expected_epoch=1, target_revision=target)
        self.assertEqual(controller.maintenance_status()["configRevision"], old_revision)
        with self.assertRaisesRegex(ValueError, "replacement_daemon_not_ready"):
            controller.complete_config_apply(apply_id=op["applyId"], expected_epoch=1, target_revision=target)
        self.pool.config_path.write_bytes(target_bytes)
        replacement = OraclePool(self.pool.config_path, self.pool.db_path, FakeTransport())
        self.assertEqual(replacement.loaded_revision, target)
        with patch("snooze.oracle_pool._identity_alive", return_value=False):
            replacement.register_daemon()
        with self.assertRaisesRegex(ValueError, "daemon_replaced"):
            self.pool.heartbeat_daemon()
        with self.assertRaisesRegex(ValueError, "daemon_replaced"):
            self.pool._claim()
        replacement._claim()
        completed = controller.complete_config_apply(apply_id=op["applyId"], expected_epoch=1, target_revision=target)
        self.assertEqual(completed["status"], "complete")
        self.assertNotEqual(completed["previousInstance"], read_daemon_status(self.pool.db_path)["instanceId"])
        self.assertEqual(controller.maintenance_status()["epoch"], 2)
        self.assertFalse(controller.maintenance_status()["paused"])
        self.assertEqual(controller.complete_config_apply(apply_id=op["applyId"], expected_epoch=1, target_revision=target), completed)
        events = [event for event in controller.events()["events"] if event.get("kind") == "config_apply_completed"]
        self.assertEqual(len(events), 1)
        self.assertEqual(completed["previousInstance"], original["instanceId"])

    def test_failed_apply_reconciles_only_with_exact_healthy_replacement(self):
        original = self.pool.register_daemon()
        old_revision = self.pool.loaded_revision
        target_bytes = json.dumps(self.pool.config, separators=(",", ":")).encode()
        target = _config_revision(target_bytes)
        self.assertNotEqual(old_revision, target)
        self.pool.request_maintenance(old_revision, 0)
        self.pool._claim()
        controller = OraclePool.open_maintenance(self.pool.db_path)
        op = controller.begin_config_apply(expected_epoch=1, target_revision=target)
        failed = controller.fail_config_apply(apply_id=op["applyId"], expected_epoch=1, error="service_restart_failed")
        self.assertEqual(failed["status"], "failed")
        self.assertEqual(failed["error"], "service_restart_failed")
        self.assertTrue(controller.maintenance_status()["paused"])
        with self.assertRaisesRegex(ValueError, "config_apply_reserved"):
            controller.release_maintenance(expected_epoch=1, config_revision=old_revision)
        self.assertEqual(controller.begin_config_apply(expected_epoch=1, target_revision=target), failed)
        with self.assertRaisesRegex(ValueError, "config_apply_conflict"):
            controller.begin_config_apply(expected_epoch=1, target_revision="G" * 24)
        with self.assertRaisesRegex(ValueError, "config_apply_conflict"):
            controller.complete_config_apply(apply_id=op["applyId"], expected_epoch=1, target_revision="G" * 24)
        with self.assertRaisesRegex(ValueError, "replacement_daemon_not_ready"):
            controller.complete_config_apply(apply_id=op["applyId"], expected_epoch=1, target_revision=target)
        self.assertEqual(controller.maintenance_status()["configRevision"], old_revision)
        self.pool.config_path.write_bytes(target_bytes)
        replacement = OraclePool(self.pool.config_path, self.pool.db_path, FakeTransport())
        with patch("snooze.oracle_pool._identity_alive", return_value=False):
            replacement.register_daemon()
        replacement._claim()
        completed = controller.complete_config_apply(apply_id=op["applyId"], expected_epoch=1, target_revision=target)
        self.assertEqual(completed["status"], "complete")
        self.assertIsNone(completed["error"])
        self.assertEqual(completed["previousInstance"], original["instanceId"])
        self.assertFalse(controller.maintenance_status()["paused"])

    def test_daemon_and_apply_readers_fail_closed_for_corrupt_schema(self):
        unavailable = Path(self.temp.name) / "missing-daemon-db"
        self.assertEqual(read_daemon_status(unavailable),
                         {"available": False, "instanceId": None, "loadedRevision": None,
                          "heartbeatAt": None, "observedEpoch": None, "alive": False})
        with self.assertRaisesRegex(ValueError, "maintenance_unavailable"):
            read_config_apply_status(unavailable)
        with self.pool._connect() as db:
            db.execute("DROP TABLE pool_config_applies")
            db.commit()
        with self.assertRaisesRegex(ValueError, "config_apply_unavailable"):
            read_config_apply_status(self.pool.db_path)
        with self.assertRaisesRegex(ValueError, "config_apply_unavailable"):
            OraclePool.open_maintenance(self.pool.db_path)

    def test_missing_apply_schema_marker_with_existing_tables_fails_closed(self):
        with self.pool._connect() as db:
            db.execute("DELETE FROM pool_meta WHERE key=?", (APPLY_SCHEMA_MARKER,))
            db.commit()
        with self.assertRaisesRegex(ValueError, "config_apply_unavailable"):
            OraclePool(self.pool.config_path, self.pool.db_path, FakeTransport())
        self.assertFalse(read_daemon_status(self.pool.db_path)["available"])
        with self.assertRaisesRegex(ValueError, "config_apply_unavailable"):
            read_config_apply_status(self.pool.db_path)

    def test_registration_rejects_stale_heartbeat_while_process_is_alive(self):
        from snooze.oracle_pool import DAEMON_FRESH_SECONDS
        self.pool.register_daemon()
        with self.pool._connect() as db:
            db.execute("UPDATE pool_daemons SET heartbeat_at=? WHERE id=1", (time.time() - DAEMON_FRESH_SECONDS - 1,))
            db.commit()
        peer = OraclePool(self.pool.config_path, self.pool.db_path, FakeTransport())
        with patch("snooze.oracle_pool._identity_alive", return_value=True):
            with self.assertRaisesRegex(ValueError, "daemon_heartbeat_stale_but_process_alive"):
                peer.register_daemon()


if __name__ == "__main__":
    unittest.main()
