import http.client
import json
import os
import socket
import stat
import tempfile
import threading
import time
import unittest
from pathlib import Path

from snooze.bridge import PrivateHTTPServer, read_auth_fd
from snooze.jobs import JobRegistry
def assignment():
    return {
        "schemaVersion": 1, "assignmentId": "job-1", "idempotencyKey": "key-1",
        "projectId": "project-a", "eligibleAccountIds": ["account-a"],
        "tasks": [{"taskId": "task-1", "dependsOn": [], "scopeKeys": ["path:src/input.json"],
                   "instructions": "Extract records",
                   "execution": {"mode": "existing-session", "accountId": "account-a", "sessionId": "session-a"},
                   "output": {"kind": "text", "maxBytes": 1024, "format": "plain", "expectedMarker": "DONE"}}],
    }


class UnixHTTPConnection(http.client.HTTPConnection):
    def __init__(self, path):
        super().__init__("local")
        self.path = path

    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.connect(self.path)


def call(path, method="GET", body=None, bearer=None, route="/admin/api/v1/assignments", owner=None, client=None):
    connection = UnixHTTPConnection(path)
    headers = {}
    payload = None
    if body is not None:
        payload = json.dumps(body)
        headers["Content-Type"] = "application/json"
    if bearer is not None:
        headers["Authorization"] = "Bearer " + bearer
    if owner is not None:
        headers["X-Owner-Principal"] = owner
    if client is not None:
        headers["X-Client-Id"] = client
    connection.request(method, route, body=payload, headers=headers)
    response = connection.getresponse()
    data = response.read()
    connection.close()
    return response.status, (json.loads(data) if data else None)


class PrivateBridgeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name) / "private"
        self.registry = JobRegistry(self.root / "jobs.sqlite3")
        self.registry.register_account({"accountId": "account-a", "enabled": True, "authorized": True,
            "health": "healthy", "quota": "available", "allowUnknownQuota": False,
            "registeredSessions": [{"id": "session-a", "model": "unknown", "workspace": "workspace-a"}]})
        self.bearer = "x" * 43
        self.socket_path = self.root / "bridge.sock"
        self.server = PrivateHTTPServer(self.socket_path, self.registry, self.bearer)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)
        self.temp.cleanup()

    def test_every_request_requires_bearer_and_socket_is_private(self):
        status, payload = call(str(self.socket_path))
        self.assertEqual(status, 401)
        self.assertEqual(payload["error"], "unauthorized")
        self.assertEqual(stat.S_IMODE(self.socket_path.stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(self.root.stat().st_mode), 0o700)

    def test_authenticated_direct_submission_is_accepted(self):
        conn = UnixHTTPConnection(str(self.socket_path))
        conn.request("POST", "/v1/assignments", body=json.dumps(assignment()), headers={
            "Authorization": "Bearer " + self.bearer, "Content-Type": "application/json"})
        response = conn.getresponse()
        result = json.loads(response.read())
        self.assertEqual(response.status, 202)
        self.assertEqual(result["state"], "queued")
        conn.close()
        status, operation = call(str(self.socket_path), method="POST", body={"workerId": "node-1"},
                                 bearer=self.bearer, route="/v1/operations/claim")
        self.assertEqual(status, 200)
        self.assertEqual(operation["kind"], "chat_session")
        self.assertEqual(operation["input"]["sessionId"], "session-a")
        self.assertEqual(operation["input"]["instructions"], "Extract records")

    def test_registered_account_route_is_authenticated(self):
        status, payload = call(str(self.socket_path), method="POST", route="/v1/accounts", bearer=self.bearer,
            body={"accountId": "account-b", "enabled": True, "authorized": True,
                  "health": "healthy", "quota": "unknown", "allowUnknownQuota": True,
                  "registeredSessions": [{"id": "session-b", "model": "unknown", "workspace": "workspace-a"}]})
        self.assertEqual(status, 200)
        self.assertEqual(payload["accountId"], "account-b")

    def test_project_controls_cross_bridge_with_revision_fence_and_isolation(self):
        route = "/admin/api/v1/projects/project-a/control"
        status, initial = call(str(self.socket_path), bearer=self.bearer, route=route)
        self.assertEqual(status, 200)
        request = {"action": "pause_dispatch", "expectedRevision": initial["revision"]}
        status, changed = call(str(self.socket_path), method="POST", bearer=self.bearer, route=route, body=request)
        self.assertEqual(status, 202)
        self.assertTrue(changed["paused"])
        self.assertEqual(call(str(self.socket_path), method="POST", bearer=self.bearer, route=route, body=request)[0], 409)
        self.assertEqual(call(str(self.socket_path), bearer=self.bearer, route="/admin/api/v1/projects/project-b/control")[1]["paused"], False)
        self.assertEqual(call(str(self.socket_path), method="POST", bearer=self.bearer, route=route,
                              body={**request, "unexpected": True})[0], 400)

    def test_owner_client_scope_is_exact_and_missing_scope_cannot_read_or_cancel(self):
        def submit(identifier, key, *, owner=None, client=None):
            body = assignment()
            body["assignmentId"] = identifier
            body["idempotencyKey"] = key
            return call(str(self.socket_path), method="POST", route="/v1/assignments", bearer=self.bearer,
                        body=body, owner=owner, client=client)

        self.assertEqual(submit("legacy", "legacy-key")[0], 202)
        self.assertEqual(submit("client-a-job", "client-a-key", owner="principal-a", client="client-a")[0], 202)
        self.assertEqual(submit("client-b-job", "client-b-key", owner="principal-a", client="client-b")[0], 202)

        status, listing = call(str(self.socket_path), bearer=self.bearer, owner="principal-a", client="client-a",
                               route="/admin/api/v1/assignments?projectId=project-a")
        self.assertEqual(status, 200)
        self.assertEqual([row["assignmentId"] for row in listing["assignments"]], ["client-a-job"])
        # The explicit admin route remains unfiltered when called without a scope.
        status, admin = call(str(self.socket_path), bearer=self.bearer,
                             route="/admin/api/v1/assignments/legacy")
        self.assertEqual(status, 200)
        self.assertEqual(admin["assignmentId"], "legacy")
        status, admin_owned = call(str(self.socket_path), bearer=self.bearer,
                                   route="/admin/api/v1/assignments/client-a-job")
        self.assertEqual(status, 200)
        self.assertEqual(admin_owned["assignmentId"], "client-a-job")
        for assignment_id in ("legacy", "client-b-job"):
            status, _ = call(str(self.socket_path), bearer=self.bearer, owner="principal-a", client="client-a",
                             route=f"/admin/api/v1/assignments/{assignment_id}")
            self.assertEqual(status, 404)

        status, _ = call(str(self.socket_path), bearer=self.bearer, owner="principal-a", client="client-a",
                         route="/v1/assignments/client-a-job/results")
        self.assertEqual(status, 200)
        for assignment_id in ("legacy", "client-b-job"):
            status, _ = call(str(self.socket_path), bearer=self.bearer, owner="principal-a", client="client-a",
                             route=f"/v1/assignments/{assignment_id}/results")
            self.assertEqual(status, 404)
        status, _ = call(str(self.socket_path), bearer=self.bearer,
                         route="/v1/assignments/client-a-job/results")
        self.assertEqual(status, 403)
        status, _ = call(str(self.socket_path), method="POST", bearer=self.bearer,
                         body={"expectedRevision": 1}, route="/v1/assignments/client-a-job/cancel")
        self.assertEqual(status, 403)
        status, _ = call(str(self.socket_path), method="POST", bearer=self.bearer, owner="principal-a", client="client-a",
                         body={"expectedRevision": 1}, route="/v1/assignments/client-b-job/cancel")
        self.assertEqual(status, 404)

    def test_scoped_bridge_status_includes_persisted_timeline_observations(self):
        body = assignment()
        body["ownerPrincipalId"] = "ignored-untrusted"
        body["clientId"] = "ignored-untrusted"
        status, _ = call(str(self.socket_path), method="POST", route="/v1/assignments", bearer=self.bearer,
                         body=body, owner="principal-a", client="client-a")
        self.assertEqual(status, 202)
        _, operation = call(str(self.socket_path), method="POST", body={"workerId": "node-1"}, bearer=self.bearer,
                            route="/v1/operations/claim")
        call(str(self.socket_path), method="POST", body={"workerId": "node-1", "outcome": "accepted"}, bearer=self.bearer,
             route=f"/v1/operations/{operation['operationId']}/result")
        _, pre_observation = call(str(self.socket_path), bearer=self.bearer, owner="principal-a", client="client-a",
                                  route="/admin/api/v1/assignments/job-1")
        self.assertIsNone(pre_observation["tasks"][0]["providerStatus"])
        self.assertIsNone(pre_observation["tasks"][0]["releasedAt"])
        with self.registry.connection(write=True) as db:
            db.execute("UPDATE operations SET due_at=0 WHERE kind='observe_session' AND state='queued'")
        _, observation = call(str(self.socket_path), method="POST", body={"workerId": "node-1"}, bearer=self.bearer,
                             route="/v1/operations/claim")
        call(str(self.socket_path), method="POST", body={"workerId": "node-1", "outcome": "accepted", "result": {
            "status": "complete", "assistantText": "DONE verified", "assistantAt": time.time() + 1, "sessionId": "session-a"}},
            bearer=self.bearer, route=f"/v1/operations/{observation['operationId']}/result")
        status, task_status = call(str(self.socket_path), bearer=self.bearer, owner="principal-a", client="client-a",
                                   route="/admin/api/v1/assignments/job-1")
        self.assertEqual(status, 200)
        task = task_status["tasks"][0]
        self.assertGreater(task["dispatchAt"], 0)
        self.assertGreater(task["releasedAt"], 0)
        self.assertEqual(task["providerStatus"], "complete")

    def _get_ambiguous_revision(self):
        """Submit job, drive it to ambiguous state, return current assignment revision."""
        body = assignment()
        status, receipt = call(str(self.socket_path), method="POST", route="/v1/assignments",
                               bearer=self.bearer, body=body, owner="principal-x", client="client-x")
        self.assertEqual(status, 202)
        _, operation = call(str(self.socket_path), method="POST", body={"workerId": "w1"},
                            bearer=self.bearer, route="/v1/operations/claim")
        self.assertIsNotNone(operation)
        call(str(self.socket_path), method="POST",
             body={"workerId": "w1", "outcome": "ambiguous"},
             bearer=self.bearer, route=f"/v1/operations/{operation['operationId']}/result")
        _, status_row = call(str(self.socket_path), bearer=self.bearer,
                             route="/admin/api/v1/assignments/job-1")
        return status_row["revision"]

    def test_reconcile_task_requires_owner_and_rejects_wrong_owner(self):
        rev = self._get_ambiguous_revision()
        # Missing owner → 403
        status, _ = call(str(self.socket_path), method="POST", bearer=self.bearer,
                         route="/v1/assignments/job-1/reconcile",
                         body={"taskId": "task-1", "expectedRevision": rev})
        self.assertEqual(status, 403)
        # Wrong owner → 404 (assignment not found for this scope)
        status, _ = call(str(self.socket_path), method="POST", bearer=self.bearer,
                         route="/v1/assignments/job-1/reconcile",
                         body={"taskId": "task-1", "expectedRevision": rev},
                         owner="wrong-owner", client="wrong-client")
        self.assertEqual(status, 404)

    def test_reconcile_task_parser_rejects_extraneous_and_invalid_args(self):
        rev = self._get_ambiguous_revision()
        # Extraneous field
        status, _ = call(str(self.socket_path), method="POST", bearer=self.bearer,
                         route="/v1/assignments/job-1/reconcile",
                         body={"taskId": "task-1", "expectedRevision": rev, "extra": True},
                         owner="principal-x", client="client-x")
        self.assertEqual(status, 400)
        # Bool expectedRevision (not allowed)
        status, _ = call(str(self.socket_path), method="POST", bearer=self.bearer,
                         route="/v1/assignments/job-1/reconcile",
                         body={"taskId": "task-1", "expectedRevision": True},
                         owner="principal-x", client="client-x")
        self.assertEqual(status, 400)
        # Zero revision
        status, _ = call(str(self.socket_path), method="POST", bearer=self.bearer,
                         route="/v1/assignments/job-1/reconcile",
                         body={"taskId": "task-1", "expectedRevision": 0},
                         owner="principal-x", client="client-x")
        self.assertEqual(status, 400)
        # Missing taskId
        status, _ = call(str(self.socket_path), method="POST", bearer=self.bearer,
                         route="/v1/assignments/job-1/reconcile",
                         body={"expectedRevision": rev},
                         owner="principal-x", client="client-x")
        self.assertEqual(status, 400)

    def test_reconcile_task_stale_revision_and_duplicate_guard(self):
        rev = self._get_ambiguous_revision()
        # Stale revision → 409
        status, _ = call(str(self.socket_path), method="POST", bearer=self.bearer,
                         route="/v1/assignments/job-1/reconcile",
                         body={"taskId": "task-1", "expectedRevision": 1},
                         owner="principal-x", client="client-x")
        self.assertEqual(status, 409)
        # Valid reconcile → 202 and queues exactly one observation
        status, result = call(str(self.socket_path), method="POST", bearer=self.bearer,
                              route="/v1/assignments/job-1/reconcile",
                              body={"taskId": "task-1", "expectedRevision": rev},
                              owner="principal-x", client="client-x")
        self.assertEqual(status, 202)
        self.assertEqual(result["taskId"], "task-1")
        self.assertEqual(result["state"], "awaiting_output")
        new_rev = result["revision"]
        # Duplicate with updated revision → 409 (pending observation already exists)
        status, _ = call(str(self.socket_path), method="POST", bearer=self.bearer,
                         route="/v1/assignments/job-1/reconcile",
                         body={"taskId": "task-1", "expectedRevision": new_rev},
                         owner="principal-x", client="client-x")
        self.assertEqual(status, 409)

    def test_auth_pipe_reads_only_a_bounded_bearer(self):
        read_fd, write_fd = os.pipe()
        os.write(write_fd, b"z" * 43 + b"\n")
        os.close(write_fd)
        try:
            self.assertEqual(read_auth_fd(read_fd), "z" * 43)
        finally:
            os.close(read_fd)


if __name__ == "__main__":
    unittest.main()
