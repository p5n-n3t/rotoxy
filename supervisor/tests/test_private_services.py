import ast
import json
import os
import tempfile
import unittest
from pathlib import Path

from snooze import private_services as services
from snooze.oracle_pool import DEFAULT_MODEL, default_config


class PrivateServicesTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        os.chmod(self.root, 0o700)
        self.registry = self.root / "private-services.json"
        self.fleet = self.root / "oracle-config.json"
        fleet = {**default_config(), "version": 2, "hosts": [{
            "id": "ora3", "ip": "100.114.191.111", "ssh_host": "shh-ora3.example",
            "enabled": True, "allowedModels": [DEFAULT_MODEL],
        }]}
        self.fleet.write_text(json.dumps(fleet))
        os.chmod(self.fleet, 0o600)

    def tearDown(self):
        self.temp.cleanup()

    def test_registry_revisioned_crud_keeps_backup_and_rejects_arbitrary_hosts(self):
        first = services.apply(self.registry, self.fleet, {"action": "read"})
        self.assertEqual([row["id"] for row in first["registry"]["services"]], ["litellm-ora3", "desktop-loopback"])
        service = {"id": "litellm-ora4", "kind": "litellm", "label": "Gateway four", "hostId": "ora3", "enabled": True,
                   "probe": {"status": "unknown", "checkedAt": None, "aliases": []}}
        second = services.apply(self.registry, self.fleet, {"action": "add", "revision": first["revision"], "service": service})
        self.assertEqual(len(second["registry"]["services"]), 3)
        backups = list(self.root.glob("private-services.json.backup.*"))
        self.assertEqual(len(backups), 1)
        self.assertEqual(backups[0].stat().st_mode & 0o777, 0o600)
        with self.assertRaisesRegex(ValueError, "service_host_unapproved"):
            bad = {**service, "id": "bad", "hostId": "attacker.example"}
            services.apply(self.registry, self.fleet, {"action": "add", "revision": second["revision"], "service": bad})
        self.assertEqual(len(services.apply(self.registry, self.fleet, {"action": "read"})["registry"]["services"]), 3)

    def test_probe_is_explicit_fixed_host_and_only_returns_bounded_aliases(self):
        ast.parse(services._LITELLM_PROBE_SCRIPT)
        current = services.apply(self.registry, self.fleet, {"action": "read"})
        calls = []
        def fake_ssh(host_id, ip, alias):
            calls.append((host_id, ip, alias))
            return {"status": "healthy", "aliases": ["model-alias", "bad alias", "x" * 121, "model-alias"]}
        result = services.apply(self.registry, self.fleet, {"action": "probe", "revision": current["revision"], "targetId": "litellm-ora3"}, fake_ssh)
        self.assertEqual(calls, [("ora3", "100.114.191.111", "shh-ora3.example")])
        service = result["registry"]["services"][0]
        self.assertEqual(service["probe"]["aliases"], ["model-alias"])
        self.assertEqual(service["probe"]["status"], "healthy")

    def test_bad_service_host_never_calls_ssh_and_untrusted_probe_fields_are_rejected(self):
        current = services.apply(self.registry, self.fleet, {"action": "read"})
        calls = []
        with self.assertRaisesRegex(ValueError, "request_invalid"):
            services.apply(self.registry, self.fleet, {"action": "probe", "revision": current["revision"], "targetId": "litellm-ora3", "url": "http://attacker"}, lambda *args: calls.append(args))
        self.assertEqual(calls, [])
        service = {"id": "bad", "kind": "litellm", "label": "Bad", "hostId": "ora4", "enabled": True,
                   "probe": {"status": "unknown", "checkedAt": None, "aliases": []}}
        with self.assertRaisesRegex(ValueError, "service_host_unapproved"):
            services.apply(self.registry, self.fleet, {"action": "add", "revision": current["revision"], "service": service})


if __name__ == "__main__":
    unittest.main()
