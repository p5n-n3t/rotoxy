import json
import os
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from snooze import oracle_apply
from snooze.oracle_pool import HOSTS, default_config
from snooze.oracle_fleet_config import _read


class OracleApplyTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name); self.root.chmod(0o700)
        self.config = self.root / "fleet.json"
        fleet = {**default_config(), "version": 2, "hosts": [
            {**host, "enabled": True, "allowedModels": ["qwen3.5:9b"]} for host in HOSTS
        ]}
        self.config.write_text(json.dumps(fleet)); self.config.chmod(0o600)
        self.db = self.root / "queue.sqlite3"; self.db.write_bytes(b"read-only-sentinel"); self.db.chmod(0o600)
        raw, _, _ = _read(self.config)
        self.revision = oracle_apply._revision(raw)
        self.epoch = 4
        self.api = self.FakeCore(self)
        self.patch = patch.object(oracle_apply, "_load_core", return_value=self.api.exports)
        self.patch.start(); self.addCleanup(self.patch.stop)

    def tearDown(self): self.temp.cleanup()

    class FakeCore:
        def __init__(self, test):
            self.test = test
            self.maintenance = {"epoch": test.epoch, "paused": True, "configRevision": test.revision,
                "acknowledged": True, "blockers": {"running": 0, "ambiguous": 0, "dispatching": 0}, "reason": "paused"}
            self.daemon = {"available": True, "instanceId": "old-instance", "loadedRevision": test.revision,
                "heartbeatAt": time.time(), "observedEpoch": test.epoch, "alive": True}
            self.operation = None
            self.begin_calls = self.complete_calls = self.fail_calls = 0
            outer = self

            class Pool:
                @classmethod
                def open_maintenance(cls, _db_path): return cls()
                def begin_config_apply(self, *, expected_epoch, target_revision):
                    outer.begin_calls += 1
                    if expected_epoch != outer.maintenance["epoch"]: raise ValueError("maintenance_epoch_conflict")
                    if (outer.operation is not None and not
                            (outer.operation["status"] == "complete" and outer.operation["epoch"] < expected_epoch)):
                        return dict(outer.operation)
                    outer.operation = {"applyId": "apply-1", "epoch": expected_epoch, "targetRevision": target_revision,
                        "previousInstance": outer.daemon["instanceId"], "status": "prepared", "error": None}
                    return dict(outer.operation)
                def complete_config_apply(self, *, apply_id, expected_epoch, target_revision):
                    outer.complete_calls += 1
                    if not outer.operation or outer.operation["applyId"] != apply_id or outer.operation["epoch"] != expected_epoch or outer.operation["targetRevision"] != target_revision:
                        raise ValueError("config_apply_conflict")
                    if outer.operation["status"] not in {"prepared", "failed"}: raise ValueError("config_apply_conflict")
                    outer.operation["status"] = "complete"
                    outer.maintenance.update(epoch=expected_epoch + 1, paused=False, configRevision=None, acknowledged=False, reason=None)
                    return dict(outer.operation)
                def fail_config_apply(self, *, apply_id, expected_epoch, error):
                    outer.fail_calls += 1
                    if not outer.operation or outer.operation["applyId"] != apply_id or outer.operation["epoch"] != expected_epoch:
                        raise ValueError("config_apply_conflict")
                    outer.operation.update(status="failed", error=error)
                    return dict(outer.operation)

            self.exports = {
                "OraclePool": Pool,
                "read_maintenance_status": lambda _db: dict(self.maintenance),
                "read_daemon_status": lambda _db: dict(self.daemon),
                "read_config_apply_status": lambda _db: dict(self.operation) if self.operation else None,
            }

    def controller(self, runner=None, wait=0):
        return oracle_apply.OracleApplyController(self.config, self.db, service_runner=runner, wait_seconds=wait)

    def healthy_restart(self, revision=None, epoch=None, instance="new-instance"):
        self.api.daemon.update(instanceId=instance, loadedRevision=revision or self.revision,
            heartbeatAt=time.time(), observedEpoch=self.epoch if epoch is None else epoch, alive=True)

    def test_success_and_status_get_leave_database_unchanged(self):
        before = self.db.read_bytes(); calls = []
        def restart(): calls.append("restart"); self.healthy_restart()
        status = self.controller(restart, wait=0).status()
        self.assertEqual(set(status), {"daemon", "operation", "maintenance", "ready", "reason"})
        self.assertTrue(status["ready"]); self.assertIsNone(status["reason"])
        self.assertEqual(before, self.db.read_bytes())
        done = self.controller(restart, wait=0).apply(self.revision, self.epoch)
        self.assertEqual(calls, ["restart"])
        self.assertEqual(done["reason"], "apply_complete")
        self.assertEqual(done["operation"]["status"], "complete")
        self.assertFalse(done["maintenance"]["paused"])
        self.assertEqual(self.api.complete_calls, 1)

    def test_apply_targets_new_config_while_fence_and_daemon_report_old_revision(self):
        old_revision = self.revision
        self.config.write_text(self.config.read_text() + "\n")
        self.config.chmod(0o600)
        new_revision = oracle_apply._revision(self.config.read_bytes())
        self.api.maintenance["configRevision"] = old_revision
        self.api.daemon["loadedRevision"] = old_revision
        calls = []
        def restart():
            calls.append(1)
            self.healthy_restart(new_revision, self.epoch)
        status = self.controller(restart, wait=0).status()
        self.assertTrue(status["ready"], status)
        result = self.controller(restart, wait=0).apply(new_revision, self.epoch)
        self.assertEqual(result["reason"], "apply_complete")
        self.assertEqual(result["operation"]["targetRevision"], new_revision)
        self.assertEqual(calls, [1])

    def test_historical_complete_operation_does_not_block_second_apply(self):
        first = self.controller(lambda: self.healthy_restart(), wait=0).apply(self.revision, self.epoch)
        self.assertEqual(first["reason"], "apply_complete")
        self.epoch += 1
        self.api.maintenance.update(epoch=self.epoch, paused=True, acknowledged=True,
            configRevision="Z" * 24, blockers={"running": 0, "ambiguous": 0, "dispatching": 0})
        self.api.daemon.update(loadedRevision="Z" * 24, observedEpoch=self.epoch, heartbeatAt=time.time())
        calls = []
        def restart():
            calls.append(1)
            self.healthy_restart(self.revision, self.epoch, "third-instance")
        result = self.controller(restart, wait=0).apply(self.revision, self.epoch)
        self.assertEqual(result["reason"], "apply_complete")
        self.assertEqual(calls, [1])
        self.assertEqual(self.api.begin_calls, 2)
        self.assertEqual(result["operation"]["epoch"], self.epoch)

    def test_failed_reservation_can_reconcile_late_exact_daemon_without_restart(self):
        self.api.operation = {"applyId": "apply-1", "epoch": self.epoch, "targetRevision": self.revision,
            "previousInstance": "old-instance", "status": "failed", "error": "daemon_not_observed"}
        self.healthy_restart()
        self.assertTrue(self.controller().status()["ready"])
        self.assertEqual(self.controller().status()["reason"], "reconcile_ready")
        calls = []
        result = self.controller(lambda: calls.append(1), wait=0).apply(self.revision, self.epoch)
        self.assertEqual(result["reason"], "apply_complete")
        self.assertEqual(calls, [])
        self.assertEqual(self.api.complete_calls, 1)

    def test_failed_reservation_without_proof_stays_blocked_and_never_restarts(self):
        self.api.operation = {"applyId": "apply-1", "epoch": self.epoch, "targetRevision": self.revision,
            "previousInstance": "old-instance", "status": "failed", "error": "restart_ambiguous"}
        calls = []
        result = self.controller(lambda: calls.append(1), wait=0).apply(self.revision, self.epoch)
        self.assertEqual(result["reason"], "recovery_required")
        self.assertEqual(calls, [])
        self.assertEqual(self.api.complete_calls, 0)

    def test_apply_flock_releases_on_process_crash_and_persistent_inode_remains(self):
        script = ("from pathlib import Path; from snooze.oracle_apply import _apply_lock; "
                  "import sys,time; p=Path(sys.argv[1]); "
                  "ctx=_apply_lock(p); ctx.__enter__(); print('locked',flush=True); time.sleep(30)")
        child = subprocess.Popen([sys.executable, "-c", script, str(self.config)],
            cwd=Path(__file__).resolve().parents[1], stdout=subprocess.PIPE, text=True)
        try:
            self.assertEqual(child.stdout.readline().strip(), "locked")
            child.kill(); child.wait(timeout=3)
            with oracle_apply._apply_lock(self.config):
                pass
            self.assertTrue(self.config.with_name(self.config.name + ".apply.lock.v2").exists())
        finally:
            if child.poll() is None: child.kill(); child.wait(timeout=3)
            child.stdout.close()

    def test_legacy_lock_sidecar_is_rejected(self):
        legacy = self.config.with_name(self.config.name + ".apply.lock")
        legacy.write_text("stale")
        with self.assertRaisesRegex(ValueError, "apply_locked"):
            with oracle_apply._apply_lock(self.config): pass

    def test_config_revision_and_epoch_cas_reject_before_restart(self):
        calls = []
        ctrl = self.controller(lambda: calls.append(1), wait=0)
        self.assertEqual(ctrl.apply("Z" * 24, self.epoch)["reason"], "config_revision_conflict")
        self.assertEqual(ctrl.apply(self.revision, self.epoch + 1)["reason"], "maintenance_epoch_conflict")
        self.assertEqual(calls, [])
        self.assertEqual(self.api.begin_calls, 0)

    def test_wrong_revision_stale_heartbeat_and_missing_new_daemon_fail_closed(self):
        for fault in ("revision", "heartbeat", "identity"):
            with self.subTest(fault=fault):
                self.api.maintenance = {"epoch": self.epoch, "paused": True, "configRevision": self.revision,
                    "acknowledged": True, "blockers": {"running": 0, "ambiguous": 0, "dispatching": 0}, "reason": "paused"}
                self.api.daemon = {"available": True, "instanceId": "old-instance", "loadedRevision": self.revision,
                    "heartbeatAt": time.time(), "observedEpoch": self.epoch, "alive": True}
                self.api.operation = None; self.api.fail_calls = 0; self.api.complete_calls = 0
                calls = []
                def restart():
                    calls.append(1)
                    self.healthy_restart()
                    if fault == "revision": self.api.daemon["loadedRevision"] = "C" * 24
                    if fault == "heartbeat": self.api.daemon["heartbeatAt"] = time.time() - 100
                    if fault == "identity": self.api.daemon["instanceId"] = "old-instance"
                ctrl = self.controller(restart, wait=0)
                failed = ctrl.apply(self.revision, self.epoch)
                self.assertEqual(failed["reason"], "recovery_required")
                self.assertEqual(self.api.fail_calls, 1)
                self.assertTrue(self.api.maintenance["paused"])
                self.assertEqual(calls, [1])
                self.assertEqual(ctrl.apply(self.revision, self.epoch)["reason"], "recovery_required")
                self.assertEqual(calls, [1], "failed/ambiguous operation must never restart again")

    def test_config_change_during_restart_keeps_fence_and_fails_operation(self):
        def restart():
            self.config.write_text(self.config.read_text() + "\n")
            self.config.chmod(0o600)
            self.healthy_restart()
        result = self.controller(restart, wait=0).apply(self.revision, self.epoch)
        self.assertEqual(result["reason"], "config_revision_conflict")
        self.assertEqual(self.api.operation["status"], "failed")
        self.assertEqual(self.api.operation["error"], "config_revision_changed")
        self.assertTrue(self.api.maintenance["paused"])
        self.assertEqual(self.api.complete_calls, 0)

    def test_existing_prepared_operation_reconciles_without_second_restart(self):
        self.api.operation = {"applyId": "apply-1", "epoch": self.epoch, "targetRevision": self.revision,
            "previousInstance": "old-instance", "status": "prepared", "error": None}
        self.healthy_restart()
        calls = []
        controller = self.controller(lambda: calls.append("restart"), wait=0)
        self.assertTrue(controller.status()["ready"])
        self.assertEqual(controller.status()["reason"], "reconcile_ready")
        result = controller.apply(self.revision, self.epoch)
        self.assertEqual(result["reason"], "apply_complete")
        self.assertEqual(calls, [])
        self.assertEqual(self.api.complete_calls, 1)

    def test_existing_operation_returned_by_begin_is_reconciled_not_restarted(self):
        api = self.api
        pool_type = api.exports["OraclePool"]
        def begin_existing(_pool, *, expected_epoch, target_revision):
            api.operation = {"applyId": "apply-race", "epoch": expected_epoch, "targetRevision": target_revision,
                "previousInstance": "old-instance", "status": "prepared", "error": None}
            self.healthy_restart()
            return dict(api.operation)
        pool_type.begin_config_apply = begin_existing
        calls = []
        result = self.controller(lambda: calls.append("restart"), wait=0).apply(self.revision, self.epoch)
        self.assertEqual(result["reason"], "apply_complete")
        self.assertEqual(calls, [])
        self.assertEqual(api.complete_calls, 1)

    def test_restart_exception_is_ambiguous_and_never_replayed(self):
        calls = []
        def uncertain(): calls.append(1); raise TimeoutError("private process detail")
        ctrl = self.controller(uncertain, wait=0)
        self.assertEqual(ctrl.apply(self.revision, self.epoch)["reason"], "recovery_required")
        self.assertEqual(self.api.operation["error"], "restart_ambiguous")
        self.assertTrue(self.api.maintenance["paused"])
        self.assertEqual(ctrl.apply(self.revision, self.epoch)["reason"], "recovery_required")
        self.assertEqual(calls, [1])

    def test_concurrent_calls_are_serialized_by_config_and_apply_locks(self):
        entered, release = threading.Event(), threading.Event()
        calls, results = [], []
        def runner():
            calls.append(1); entered.set(); release.wait(2); self.healthy_restart()
        ctrl = self.controller(runner, wait=1)
        worker = threading.Thread(target=lambda: results.append(ctrl.apply(self.revision, self.epoch)))
        worker.start(); self.assertTrue(entered.wait(1))
        second = ctrl.apply(self.revision, self.epoch)
        release.set(); worker.join(3)
        self.assertFalse(worker.is_alive())
        self.assertEqual(second["reason"], "config_locked")
        self.assertEqual(calls, [1])
        self.assertEqual(results[0]["reason"], "apply_complete")

    def test_missing_core_apis_report_not_ready_without_mutation(self):
        before = self.db.read_bytes()
        with patch.object(oracle_apply, "_load_core", side_effect=ValueError("core_api_unavailable")):
            view = self.controller().status()
        self.assertFalse(view["ready"])
        self.assertEqual(view["reason"], "core_api_unavailable")
        self.assertEqual(view["daemon"]["instanceId"], None)
        self.assertEqual(before, self.db.read_bytes())

    def test_default_service_runner_uses_only_fixed_restart_and_local_session_environment(self):
        with patch.dict(os.environ, {"HOME": "/tmp/test-home", "XDG_RUNTIME_DIR": "/tmp/runtime",
                                     "DBUS_SESSION_BUS_ADDRESS": "unix:path=/tmp/bus", "PATH": "/untrusted"}, clear=True), \
             patch.object(oracle_apply.subprocess, "run") as run:
            oracle_apply._service_restart()
        args, kwargs = run.call_args
        self.assertEqual(args[0], ["/usr/bin/systemctl", "--user", "restart", "rotoxy-oracle-pool.service"])
        self.assertFalse(kwargs["shell"]); self.assertEqual(kwargs["timeout"], 10); self.assertTrue(kwargs["check"])
        self.assertEqual(set(kwargs["env"]), {"HOME", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"})
        self.assertEqual(kwargs["env"]["HOME"], "/tmp/test-home")


if __name__ == "__main__": unittest.main()
