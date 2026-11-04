import json
import http.client
import socket
import tempfile
import threading
import unittest
from pathlib import Path

from snooze.jobs import JobRegistry, validate_assignment
from snooze.bridge import PrivateHTTPServer
from test_jobs import assignment, task


PROFILE = "profile-claude-0001"
ACCOUNT = f"claude-code:{PROFILE}"
MODEL = "claude-sonnet-4-6"


def agent_task(task_id="agent-task", *, depends=None, account=ACCOUNT, timeout=60000):
    value = task(task_id, account=account, depends=depends)
    value["execution"] = {"mode": "agent", "provider": "claude-code", "accountId": account,
                          "profileId": PROFILE, "model": MODEL, "timeoutMs": timeout}
    return value


class JobRegistryAgentTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.db = Path(self.temp.name) / "private" / "jobs.sqlite3"
        self.registry = JobRegistry(self.db)
        self.register_agent()

    def tearDown(self):
        self.temp.cleanup()

    def register_agent(self, *, models=None, timeout=120000):
        return self.registry.register_account({
            "accountId": ACCOUNT, "enabled": True, "authorized": True,
            "allowUnknownQuota": False, "health": "healthy", "quota": "available",
            "localCapacity": 4, "registeredSessions": [], "agentProviders": [{
                "provider": "claude-code", "profileId": PROFILE,
                "models": models or [MODEL], "timeoutMs": timeout,
            }],
        }, now=1)

    def submit(self, tasks=None, *, client_id="client-owner", job_id="agent-job"):
        body = assignment(job_id, f"key-{job_id}", tasks or [agent_task()], accounts=[ACCOUNT])
        body["clientId"] = client_id
        body["ownerPrincipalId"] = f"oauth-client:{client_id}"
        self.registry.submit(body, now=2)
        return body

    def claim(self, worker="main-bridge", *, now=3, lease=30):
        return self.registry.claim_operation(worker, lease_seconds=lease, now=now)

    @staticmethod
    def accepted(worker, *, attempt="claude-attempt-42", artifact="artifact-42", request_at=3, answer_at=4,
                 text="Review result\nDONE", model=MODEL, profile=PROFILE, cost=0.02):
        result = {"assistantText": text, "reportedModel": model, "attemptId": attempt,
                  "artifactId": artifact, "profileId": profile,
                  "requestStartedAt": request_at, "assistantAt": answer_at}
        if cost is not None:
            result["costUsd"] = cost
        return {"workerId": worker, "outcome": "accepted", "result": result}

    def test_agent_contract_is_strict_and_profile_binding_is_necessary(self):
        body = assignment(tasks=[agent_task()], accounts=[ACCOUNT])
        for invalid in (
            {"mode": "agent", "provider": "claude", "accountId": ACCOUNT, "profileId": PROFILE, "model": MODEL, "timeoutMs": 60000},
            {"mode": "agent", "provider": "claude-code", "accountId": "other", "profileId": PROFILE, "model": MODEL, "timeoutMs": 60000},
            {"mode": "agent", "provider": "claude-code", "accountId": ACCOUNT, "profileId": PROFILE, "model": MODEL, "timeoutMs": 99},
            {**agent_task()["execution"], "unexpected": True},
        ):
            body["tasks"][0]["execution"] = invalid
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                validate_assignment(body)
        body["tasks"][0]["execution"] = agent_task()["execution"]
        with self.assertRaisesRegex(ValueError, "owner-bound registered profile"):
            self.registry.submit(body, now=2)
        no_owner = assignment("no-owner", "no-owner-key", [agent_task()], accounts=[ACCOUNT])
        with self.assertRaisesRegex(ValueError, "owner-bound registered profile"):
            self.registry.submit(no_owner, now=2)

    def test_operation_is_owner_bound_profile_pinned_and_completes_dependency(self):
        self.submit([agent_task("first"), agent_task("second", depends=["first"])])
        operation = self.claim()
        self.assertEqual(operation["kind"], "run_agent")
        self.assertIsNone(operation["sessionId"])
        self.assertEqual(operation["input"], {
            "projectId": "project-a", "clientId": "client-owner", "jobId": "agent-job", "taskId": "first",
            "profileId": PROFILE, "model": MODEL, "prompt": "Do bounded work for first", "timeoutMs": 60000,
            "expectedMarker": "DONE", "dispatchAt": 3,
        })
        done = self.registry.record_result(operation["operationId"], self.accepted("main-bridge"), now=5)
        self.assertEqual(done["state"], "complete")
        output = self.registry.assignment_results("agent-job", owner_principal_id="oauth-client:client-owner",
                                                  client_id="client-owner")["results"][0]
        self.assertEqual(output["text"], "Review result\nDONE")
        self.assertEqual(output["attemptId"], "claude-attempt-42")
        self.assertEqual(output["artifactId"], "artifact-42")
        self.assertEqual(output["costUsd"], 0.02)
        child = self.claim(worker="main-bridge", now=6)
        self.assertEqual(child["kind"], "run_agent")
        self.assertEqual(child["input"]["taskId"], "second")

    def test_profile_change_is_blocked_while_reserved_and_claim_rechecks_binding(self):
        self.submit()
        self.claim()
        with self.assertRaisesRegex(ValueError, "agent profile allowlist while a task is reserved"):
            self.register_agent(models=["claude-opus-4-1"])
        self.tearDown()
        self.setUp()
        self.submit()
        # Simulate a policy change from an older binary that did not enforce the
        # active-binding guard. The claim must still refuse provider dispatch.
        with self.registry.connection(write=True) as db:
            row = db.execute("SELECT data,revision FROM registered_accounts WHERE account_id=?", (ACCOUNT,)).fetchone()
            data = json.loads(row["data"])
            data["agentProviders"] = [{"provider": "claude-code", "profileId": PROFILE,
                                      "models": ["claude-opus-4-1"], "timeoutMs": 120000}]
            db.execute("UPDATE registered_accounts SET data=?,revision=revision+1 WHERE account_id=?",
                       (json.dumps(data), ACCOUNT))
        self.assertIsNone(self.claim())
        state = self.registry.get_assignment("agent-job")["tasks"][0]["state"]
        self.assertEqual(state, "queued", "a stale profile binding must not be dispatched")

    def test_bad_receipts_do_not_complete_and_lease_expiry_is_ambiguous_no_replay(self):
        for job_id, text in (("bad-marker", "DONE in body"), ("bad-profile", "DONE")):
            self.submit([agent_task(job_id)], job_id=job_id)
            operation = self.claim(now=3 if job_id == "bad-marker" else 6)
            receipt = self.accepted("main-bridge", text=text,
                                    profile="another-profile" if job_id == "bad-profile" else PROFILE,
                                    request_at=operation["input"]["dispatchAt"],
                                    answer_at=operation["input"]["dispatchAt"] + 1)
            with self.assertRaises(ValueError):
                self.registry.record_result(operation["operationId"], receipt, now=operation["input"]["dispatchAt"] + 2)
            self.assertEqual(self.registry.get_assignment(job_id)["tasks"][0]["state"], "reserved")

        self.submit(job_id="lease-job")
        first = self.claim(now=10, lease=1)
        self.assertEqual(first["kind"], "run_agent")
        self.assertIsNone(self.claim(worker="other-bridge", now=12))
        status = self.registry.get_assignment("lease-job")["tasks"][0]
        self.assertEqual(status["state"], "ambiguous")
        self.assertTrue(status["reconciliation"]["required"])
        self.assertFalse(status["reconciliation"]["redispatchAllowed"])

    def test_operation_input_owner_cannot_be_rebound(self):
        self.submit()
        with self.registry.connection(write=True) as db:
            # The scheduler creates its first operation during claim; seed a
            # forged client field on the task body and prove it is ignored.
            row = db.execute("SELECT body FROM job_tasks WHERE assignment='agent-job'").fetchone()
            spec = json.loads(row["body"])
            spec["clientId"] = "attacker"
            db.execute("UPDATE job_tasks SET body=? WHERE assignment='agent-job'", (json.dumps(spec),))
        operation = self.claim()
        self.assertEqual(operation["input"]["clientId"], "client-owner")
        with self.registry.connection(write=True) as db:
            db.execute("UPDATE operations SET input=json_set(input,'$.clientId','attacker') WHERE id=?", (operation["operationId"],))
            db.execute("UPDATE operations SET state='queued',worker=NULL,lease_until=NULL WHERE id=?", (operation["operationId"],))
        self.assertIsNone(self.claim(worker="another", now=4))
        self.assertEqual(self.registry.get_assignment("agent-job")["tasks"][0]["state"], "blocked")

    def test_capacity_accepts_generated_underscore_account_ids(self):
        self.assertEqual(self.registry.account_capacity(["_opaque-account"]), {"accounts": []})

    def test_retained_ambiguous_attempt_reduces_read_only_account_capacity(self):
        self.submit(job_id="retained-job")
        operation = self.claim(now=3, lease=1)
        self.assertEqual(operation["kind"], "run_agent")
        self.assertIsNone(self.claim(worker="reaper", now=5))
        before = self.registry.get_assignment("retained-job")
        capacity = self.registry.account_capacity([ACCOUNT])
        self.assertEqual(capacity, {"accounts": [{"accountId": ACCOUNT, "capacity": 4,
                                                   "occupied": 1, "available": 3, "retained": 1}]})
        after = self.registry.get_assignment("retained-job")
        self.assertEqual(after, before, "capacity read must not reconcile, queue, or mutate retained work")
        with self.assertRaisesRegex(ValueError, "unique safe IDs"):
            self.registry.account_capacity([ACCOUNT, ACCOUNT])
        for invalid in ([], ["../secret"], [None], ["a" * 129], ["valid", *[f"x{i}" for i in range(50)] ]):
            with self.subTest(invalid=invalid[:2]), self.assertRaises(ValueError):
                self.registry.account_capacity(invalid)

    def test_private_capacity_route_requires_bearer_exact_body_and_hides_unknown_ids(self):
        self.submit(job_id="bridge-retained")
        self.claim(now=3, lease=1)
        self.assertIsNone(self.claim(worker="reaper", now=5))
        bearer = "private-bridge-test-bearer-0123456789"
        path = Path(self.temp.name) / "private" / "capacity.sock"
        server = PrivateHTTPServer(path, self.registry, bearer)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()

        def post(body, token=bearer, route="/v1/accounts/capacity"):
            conn = http.client.HTTPConnection("local")
            conn.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            conn.sock.connect(str(path))
            headers = {"Content-Type": "application/json"}
            if token is not None:
                headers["Authorization"] = "Bearer " + token
            conn.request("POST", route, body=json.dumps(body), headers=headers)
            response = conn.getresponse()
            payload = response.read()
            conn.close()
            return response.status, json.loads(payload) if payload else None

        try:
            status, value = post({"accountIds": [ACCOUNT, "unregistered-account"]})
            self.assertEqual(status, 200)
            self.assertEqual([row["accountId"] for row in value["accounts"]], [ACCOUNT])
            self.assertEqual(value["accounts"][0]["retained"], 1)
            self.assertEqual(post({"accountIds": [ACCOUNT]}, token=None)[0], 401)
            self.assertEqual(post({"accountIds": [ACCOUNT], "reveal": True})[0], 400)
            self.assertEqual(post({"accountIds": [ACCOUNT, ACCOUNT]})[0], 400)
            self.assertEqual(post({"accountIds": [ACCOUNT]}, route="/v1/accounts/capacity?extra=1")[0], 400)
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)


if __name__ == "__main__":
    unittest.main()
