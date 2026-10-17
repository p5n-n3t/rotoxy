import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from snooze.oracle_pool import DEFAULT_MODEL, HOSTS, default_config


class OracleFleetConfigTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="rotoxy-fleet-config-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        # Keep any incidental state resolution confined before invoking the CLI.
        self.old_home = os.environ.get("HOME")
        self.old_config = os.environ.get("TOKEN2OAUTH_CONFIG_DIR")
        os.environ["HOME"] = str(self.root / "home")
        os.environ["TOKEN2OAUTH_CONFIG_DIR"] = str(self.root / "gateway-config")
        self.config = self.root / "state" / "oracle-pool" / "config.json"
        self.config.parent.mkdir(parents=True)
        self.config.parent.chmod(0o700)
        self.config.write_text(json.dumps(default_config(), indent=2) + "\n")
        self.config.chmod(0o600)
        self.supervisor = Path(__file__).resolve().parents[1]

    def tearDown(self):
        if self.old_home is None:
            os.environ.pop("HOME", None)
        else:
            os.environ["HOME"] = self.old_home
        if self.old_config is None:
            os.environ.pop("TOKEN2OAUTH_CONFIG_DIR", None)
        else:
            os.environ["TOKEN2OAUTH_CONFIG_DIR"] = self.old_config

    def cli(self, request):
        return subprocess.run([sys.executable, "-m", "snooze.oracle_fleet_config", "--config", str(self.config)],
                              cwd=self.supervisor, input=json.dumps(request), text=True,
                              capture_output=True, timeout=5)

    def test_v1_read_and_add_converts_with_backup_revision_and_no_database_or_key_writes(self):
        master = self.root / "gateway-config" / "master.key"
        master.parent.mkdir(parents=True)
        master.write_bytes(b"sentinel-master-key")
        database = self.config.parent / "queue.sqlite3"
        database.write_bytes(b"existing-queue")
        before = self.config.read_bytes()
        read = self.cli({"action": "read"})
        self.assertEqual(read.returncode, 0, read.stdout)
        snapshot = json.loads(read.stdout)
        self.assertEqual(snapshot["version"], 1)
        self.assertEqual([host["id"] for host in snapshot["hosts"]], [host["id"] for host in HOSTS])
        host = {"id": "ora7", "ip": "100.68.1.7", "ssh_host": "shh-ora7.ziopsyop.tech",
                "enabled": True, "allowedModels": [DEFAULT_MODEL]}
        saved = self.cli({"action": "add", "revision": snapshot["revision"], "host": host})
        self.assertEqual(saved.returncode, 0, saved.stdout)
        result = json.loads(saved.stdout)
        self.assertEqual(result["version"], 2)
        self.assertEqual(result["hosts"][-1]["id"], "ora7")
        renamed = {**host, "id": "ora8", "ip": "100.69.1.8", "ssh_host": "shh-ora8.ziopsyop.tech"}
        updated = self.cli({"action": "update", "revision": result["revision"], "targetId": "ora7", "host": renamed})
        self.assertEqual(updated.returncode, 0, updated.stdout)
        result = json.loads(updated.stdout)
        self.assertEqual(result["hosts"][-1]["id"], "ora8")
        deleted = self.cli({"action": "remove", "revision": result["revision"], "targetId": "ora8"})
        self.assertEqual(deleted.returncode, 0, deleted.stdout)
        result = json.loads(deleted.stdout)
        self.assertEqual([row["id"] for row in result["hosts"]], [row["id"] for row in HOSTS])
        backup = self.config.with_name(self.config.name + ".backup." + snapshot["revision"])
        self.assertEqual(backup.read_bytes(), before)
        self.assertEqual(backup.stat().st_mode & 0o777, 0o600)
        self.assertEqual(master.read_bytes(), b"sentinel-master-key")
        self.assertEqual(database.read_bytes(), b"existing-queue")
        self.assertFalse(self.config.with_name(self.config.name + ".lock").exists())

    def test_revision_conflict_invalid_host_and_last_default_model_removal_are_rejected(self):
        snapshot = json.loads(self.cli({"action": "read"}).stdout)
        invalid = {"id": "bad;id", "ip": "127.0.0.1", "ssh_host": "x;touch /tmp/x",
                   "enabled": True, "allowedModels": [DEFAULT_MODEL]}
        response = self.cli({"action": "add", "revision": snapshot["revision"], "host": invalid})
        self.assertEqual(response.returncode, 2)
        self.assertEqual(json.loads(response.stdout)["error"], "config_invalid")
        conflict = self.cli({"action": "remove", "revision": "A" * 24, "targetId": "ora1"})
        self.assertEqual(json.loads(conflict.stdout)["error"], "revision_conflict")
        # A valid removal that would strand the configured default model is rejected.
        one_host = {"id": "ora1", "ip": "100.65.151.42", "ssh_host": "shh-ora1.ziopsyop.tech",
                    "enabled": True, "allowedModels": [DEFAULT_MODEL]}
        self.config.write_text(json.dumps({**default_config(), "version": 2, "hosts": [one_host]}))
        self.config.chmod(0o600)
        current = json.loads(self.cli({"action": "read"}).stdout)
        removed = self.cli({"action": "remove", "revision": current["revision"], "targetId": "ora1"})
        self.assertEqual(removed.returncode, 2)
        self.assertEqual(json.loads(removed.stdout)["error"], "last_host_required")

    def test_existing_lock_refuses_overwrite(self):
        snapshot = json.loads(self.cli({"action": "read"}).stdout)
        lock = self.config.with_name(self.config.name + ".lock")
        lock.write_text("other writer")
        response = self.cli({"action": "add", "revision": snapshot["revision"], "host": {
            "id": "ora7", "ip": "100.68.1.7", "ssh_host": "shh-ora7.ziopsyop.tech",
            "enabled": True, "allowedModels": [DEFAULT_MODEL]}})
        self.assertEqual(json.loads(response.stdout)["error"], "config_locked")

    def test_fleet_lock_is_released_after_process_crash_without_unlinking_inode(self):
        from snooze.oracle_fleet_config import _locked
        script = "from pathlib import Path; import os; from snooze.oracle_fleet_config import _locked; lock=_locked(Path(os.environ['FLEET_TEST_CONFIG'])); lock.__enter__(); os._exit(0)"
        env = {**os.environ, "FLEET_TEST_CONFIG": str(self.config)}
        result = subprocess.run([sys.executable, "-c", script], env=env, capture_output=True, timeout=5)
        self.assertEqual(result.returncode, 0, result.stderr)
        lock_path = self.config.with_name(self.config.name + ".lock.v2")
        inode = lock_path.stat().st_ino
        with _locked(self.config):
            self.assertEqual(lock_path.stat().st_ino, inode)
            nested = subprocess.run([sys.executable, "-c", script], env=env, capture_output=True, timeout=5)
            self.assertNotEqual(nested.returncode, 0)
        with _locked(self.config):
            self.assertEqual(lock_path.stat().st_ino, inode)


if __name__ == "__main__":
    unittest.main()
