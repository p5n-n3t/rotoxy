import json
import os
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from snooze.oracle_pool import (
    APPROVED_MODELS,
    HOSTS,
    DEFAULT_MODEL,
    MAX_PENDING,
    OraclePool,
    PoolError,
    SSHOllamaTransport,
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


if __name__ == "__main__":
    unittest.main()
