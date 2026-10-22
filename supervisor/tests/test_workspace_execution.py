import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SUPERVISOR = str(Path(__file__).resolve().parent.parent)


def ledger(db_path, request):
    proc = subprocess.run(
        [sys.executable, "-m", "snooze.workspace_execution", "--db", str(db_path)],
        cwd=SUPERVISOR,
        input=json.dumps(request).encode(),
        capture_output=True,
        timeout=30,
    )
    return proc.returncode, json.loads(proc.stdout) if proc.stdout.strip() else None


def reserve(db_path, job_id, client_id="client-a"):
    return ledger(db_path, {
        "command": "reserve",
        "projectId": "project-a",
        "jobId": job_id,
        "remoteJobId": f"remote-{job_id}",
        "clientId": client_id,
        "actor": f"client:{client_id}",
        "idempotencyKey": f"key-{job_id}",
        "remoteIdempotencyKey": f"remote-key-{job_id}",
        "requestHash": "a" * 64,
        "submission": {"projectId": "project-a", "jobId": job_id, "tasks": []},
        "remoteSubmission": {"projectId": "project-a", "jobId": f"remote-{job_id}"},
    })


class TestClientIdValidator(unittest.TestCase):

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.db = Path(self.temp.name) / "agent-workspace.sqlite3"

    def test_leading_underscore_client_id_accepted(self):
        code, result = reserve(self.db, "job-u", "_underscore-client")
        self.assertEqual(code, 0, result)
        self.assertTrue(result["created"])

    def test_leading_dash_client_id_accepted(self):
        code, result = reserve(self.db, "job-d", "-dash-client")
        self.assertEqual(code, 0, result)
        self.assertTrue(result["created"])

    def test_leading_dot_client_id_accepted(self):
        code, result = reserve(self.db, "job-dot", ".dot-client")
        self.assertEqual(code, 0, result)
        self.assertTrue(result["created"])

    def test_leading_colon_client_id_accepted(self):
        code, result = reserve(self.db, "job-colon", ":colon-client")
        self.assertEqual(code, 0, result)
        self.assertTrue(result["created"])

    def test_ordinary_alphanumeric_client_id_accepted(self):
        code, result = reserve(self.db, "job-normal", "normalClient123")
        self.assertEqual(code, 0, result)
        self.assertTrue(result["created"])

    def test_cross_client_isolation(self):
        code_a, result_a = reserve(self.db, "iso-job-a", "_client-a")
        self.assertEqual(code_a, 0)
        self.assertTrue(result_a["created"])
        code_b, result_b = reserve(self.db, "iso-job-b", "-client-b")
        self.assertEqual(code_b, 0)
        self.assertTrue(result_b["created"])
        _, get_a = ledger(self.db, {"command": "get", "projectId": "project-a", "jobId": "iso-job-a", "clientId": "_client-a"})
        _, get_b = ledger(self.db, {"command": "get", "projectId": "project-a", "jobId": "iso-job-b", "clientId": "-client-b"})
        self.assertNotEqual(get_a["remoteJobId"], get_b["remoteJobId"])
        code_cross, result_cross = ledger(self.db, {"command": "get", "projectId": "project-a", "jobId": "iso-job-a", "clientId": "-client-b"})
        self.assertEqual(code_cross, 2, "cross-client get must fail")
        self.assertEqual(result_cross["error"], "execution_not_found")

    def test_unsafe_characters_rejected(self):
        for bad in ["client/bad", "client<xss>", 'client"inject', "client\x00null",
                     " leading-space", "client\ttab", ""]:
            code, result = reserve(self.db, "job-bad", bad)
            self.assertEqual(code, 2, f"Expected rejection for clientId={bad!r}")
            self.assertIn(result["error"], ("invalid_client_id", "invalid_input"))

    def test_too_long_client_id_rejected(self):
        code, result = reserve(self.db, "job-long", "a" * 129)
        self.assertEqual(code, 2)
        self.assertIn(result["error"], ("invalid_client_id", "invalid_input"))

    def test_set_state_with_leading_underscore_client(self):
        reserve(self.db, "job-state", "_state-client")
        code, result = ledger(self.db, {
            "command": "set_state",
            "projectId": "project-a",
            "jobId": "job-state",
            "clientId": "_state-client",
            "state": "accepted",
        })
        self.assertEqual(code, 0)
        self.assertEqual(result["state"], "accepted")

    def test_settle_with_leading_dash_client(self):
        reserve(self.db, "job-settle", "-settle-client")
        code, result = ledger(self.db, {
            "command": "settle_reconciliation",
            "projectId": "project-a",
            "jobId": "job-settle",
            "clientId": "-settle-client",
        })
        self.assertEqual(code, 0)
        self.assertTrue(result["settled"])

    def test_resource_id_rejects_leading_underscore(self):
        code, result = ledger(self.db, {
            "command": "reserve",
            "projectId": "project-a",
            "jobId": "_bad-job",
            "remoteJobId": "remote-bad",
            "clientId": "valid-client",
            "actor": "client:valid-client",
            "idempotencyKey": "key-bad",
            "remoteIdempotencyKey": "remote-key-bad",
            "requestHash": "a" * 64,
            "submission": {},
            "remoteSubmission": {},
        })
        self.assertEqual(code, 2)
        self.assertEqual(result["error"], "invalid_job_id")


if __name__ == "__main__":
    unittest.main()
